import { providerFromEngine } from "@toruslabs/base-controllers";
import { JRPCEngine, JRPCEngineEndCallback, JRPCEngineNextCallback, JRPCMiddleware, JRPCRequest, JRPCResponse, createAsyncMiddleware, mergeMiddleware } from "@toruslabs/openlogin-jrpc";
import { CHAIN_NAMESPACES, CustomChainConfig, WalletLoginError } from "@web3auth/base";
import { BaseProvider, BaseProviderConfig, BaseProviderState } from "@web3auth/base-provider";
import { TransactionOrVersionedTransaction } from "@web3auth/solana-provider";
import { IProviderHandlers } from "@web3auth/solana-provider/dist/types/rpc/solanaRpcMiddlewares";


function createChainIdMiddleware(chainId: string) {
  return (req: JRPCRequest<unknown>, res: JRPCResponse<string>, next: JRPCEngineNextCallback, end: JRPCEngineEndCallback): any => {
    if (req.method === "solana_chainId") {
      res.result = chainId;
      return end();
    }
    return next();
  };
}

function createProviderConfigMiddleware(providerConfig: Omit<CustomChainConfig, "chainNamespace">): any {
  return (
    req: JRPCRequest<unknown>,
    res: JRPCResponse<Omit<CustomChainConfig, "chainNamespace">>,
    next: JRPCEngineNextCallback,
    end: JRPCEngineEndCallback
  ) => {
    if (req.method === "solana_provider_config") {
      res.result = providerConfig;
      return end();
    }
    return next();
  };
}

function createConfigMiddleware(providerConfig: Omit<CustomChainConfig, "chainNamespace">): JRPCMiddleware<unknown, unknown> {
  const { chainId } = providerConfig;

  return mergeMiddleware([createChainIdMiddleware(chainId), createProviderConfigMiddleware(providerConfig)]);
}

function createGetAccountsMiddleware({ getAccounts }: { getAccounts: IProviderHandlers["getAccounts"] }): any {
  return createAsyncMiddleware(async (request, response, next) => {
    const { method } = request;
    if (method !== "getAccounts") return next();

    if (!getAccounts) throw new Error("WalletMiddleware - opts.getAccounts not provided");
    // This calls from the prefs controller
    const accounts = await getAccounts(request);
    response.result = accounts;
    return undefined;
  });
}

function createGenericJRPCMiddleware<T, U>(
  targetMethod: string,
  handler: (req: JRPCRequest<T>) => Promise<U>
): any {
  return createAsyncMiddleware<T, unknown>(async (request, response, next) => {
    const { method } = request;
    if (method !== targetMethod) return next();

    if (!handler) throw new Error(`WalletMiddleware - ${targetMethod} not provided`);

    const result = await handler(request);

    response.result = result;
    return undefined;
  });
}

function createRequestAccountsMiddleware({
  requestAccounts,
}: {
  requestAccounts: IProviderHandlers["requestAccounts"];
}): JRPCMiddleware<unknown, unknown> {
  return createAsyncMiddleware(async (request, response, next) => {
    const { method } = request;
    if (method !== "requestAccounts") return next();

    if (!requestAccounts) throw new Error("WalletMiddleware - opts.requestAccounts not provided");
    // This calls the UI login function
    const accounts = await requestAccounts(request);
    response.result = accounts;
    return undefined;
  });
}

function createSolanaMiddleware(providerHandlers: IProviderHandlers): JRPCMiddleware<unknown, unknown> {
  const { getAccounts, requestAccounts, signTransaction, signAndSendTransaction, signAllTransactions, signMessage, getPrivateKey, getSecretKey } =
    providerHandlers;

  return mergeMiddleware([
    createRequestAccountsMiddleware({ requestAccounts }),
    createGetAccountsMiddleware({ getAccounts }),
    createGenericJRPCMiddleware<{ message: TransactionOrVersionedTransaction }, TransactionOrVersionedTransaction>(
      "signTransaction",
      signTransaction
    ),
    createGenericJRPCMiddleware<{ message: TransactionOrVersionedTransaction }, { signature: string }>(
      "signAndSendTransaction",
      signAndSendTransaction
    ),
    createGenericJRPCMiddleware<{ message: TransactionOrVersionedTransaction[] }, TransactionOrVersionedTransaction[]>(
      "signAllTransactions",
      signAllTransactions
    ),
    createGenericJRPCMiddleware<{ message: Uint8Array }, Uint8Array>("signMessage", signMessage),
    createGenericJRPCMiddleware<void, string>("solanaPrivateKey", getPrivateKey),
    createGenericJRPCMiddleware<void, string>("private_key", getPrivateKey),
    createGenericJRPCMiddleware<void, string>("solanaSecretKey", getSecretKey),
  ]);
}

export abstract class BaseInjectedProvider<P> extends BaseProvider<BaseProviderConfig, BaseProviderState, P> {
  constructor({ config, state }: { config: BaseProviderConfig; state?: BaseProviderState }) {
    super({ config: { chainConfig: { ...config.chainConfig, chainNamespace: CHAIN_NAMESPACES.SOLANA } }, state });
  }

  public async switchChain(_: { chainId: string }): Promise<void> {
    throw WalletLoginError.unsupportedOperation("Chain switching is not supported by this adapter");
  }

  public async setupProvider(injectedProvider: P): Promise<void> {
    const engine = new JRPCEngine();

    const providerHandlers = this.getProviderHandlers(injectedProvider);
    const solanaMiddleware = createSolanaMiddleware(providerHandlers);
    engine.push(solanaMiddleware);

    const configMiddleware = createConfigMiddleware(this.config.chainConfig as CustomChainConfig);
    engine.push(configMiddleware);

    const injectedProviderProxy = this.getInjectedProviderProxy(injectedProvider);
    if (injectedProviderProxy) {
      engine.push(injectedProviderProxy);
    }

    const provider = providerFromEngine(engine as any);
    this.updateProviderEngineProxy(provider);
    await this.lookupNetwork();
  }

  protected async lookupNetwork(): Promise<string> {
    const { chainConfig } = this.config;
    this.update({
      chainId: chainConfig.chainId,
    });
    return chainConfig.chainId || "";
  }

  protected getInjectedProviderProxy(_: P): any {
    return undefined;
  }

  protected abstract getProviderHandlers(injectedProvider: P): IProviderHandlers;
}
