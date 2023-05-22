import type { Cluster } from "@solana/web3.js";
import {
  ADAPTER_CATEGORY,
  ADAPTER_CATEGORY_TYPE,
  ADAPTER_EVENTS,
  ADAPTER_NAMESPACES,
  ADAPTER_STATUS,
  ADAPTER_STATUS_TYPE,
  AdapterInitOptions,
  AdapterNamespaceType,
  BaseAdapterSettings,
  CHAIN_NAMESPACES,
  ChainNamespaceType,
  CONNECTED_EVENT_DATA,
  CustomChainConfig,
  log,
  SafeEventEmitterProvider,
  UserInfo,
  WALLET_ADAPTERS,
  WalletLoginError,
  Web3AuthError,
} from "@web3auth/base";
import { BaseSolanaAdapter } from "@web3auth/base-solana-adapter";
import { DemonWalletAdapter } from "./demonWalletAdapter";
import { DemonInjectedProvider, DemonWallet } from "./providerHandlers";

export type DemonWalletOptions = BaseAdapterSettings;

export class DemonAdapter extends BaseSolanaAdapter<void> {
  readonly name: string = 'DEMON';

  readonly adapterNamespace: AdapterNamespaceType = ADAPTER_NAMESPACES.SOLANA;

  readonly currentChainNamespace: ChainNamespaceType = CHAIN_NAMESPACES.SOLANA;

  readonly type: ADAPTER_CATEGORY_TYPE = ADAPTER_CATEGORY.EXTERNAL;

  public status: ADAPTER_STATUS_TYPE = ADAPTER_STATUS.NOT_READY;

  public _wallet: DemonWalletAdapter | null = null;

  private demonProvider: DemonInjectedProvider | null = null;

  get isWalletConnected(): boolean {
    return !!(
      this._wallet?.connected && this.status === ADAPTER_STATUS.CONNECTED
    );
  }

  get provider(): SafeEventEmitterProvider | null {
    return this.demonProvider?.provider || null;
  }

  set provider(_: SafeEventEmitterProvider | null) {
    throw new Error("Not implemented");
  }

  async init(options: AdapterInitOptions = {}): Promise<void> {
    await super.init(options);
    super.checkInitializationRequirements();
    this.demonProvider = new DemonInjectedProvider({
      config: { chainConfig: this.chainConfig as CustomChainConfig },
    });
    console.log(' this.demonProvider',  this.demonProvider);
    this.status = ADAPTER_STATUS.READY;
    this.emit(ADAPTER_EVENTS.READY, 'DEMON');

    try {
      log.debug("initializing demon adapter");
      if (options.autoConnect) {
        this.rehydrated = true;
        await this.connect();
      }
    } catch (error) {
      log.error("Failed to connect with cached demon provider", error);
      this.emit("ERRORED", error);
    }
  }

  async connect(): Promise<SafeEventEmitterProvider | null> {
    try {
      super.checkConnectionRequirements();
      this.status = ADAPTER_STATUS.CONNECTING;
      this.emit(ADAPTER_EVENTS.CONNECTING, {
        adapter: 'DEMON',
      });
      let cluster: Cluster = "mainnet-beta";
      if (this.chainConfig?.chainId === "0x1") {
        cluster = "mainnet-beta";
      } else if (this.chainConfig?.chainId === "0x2") {
        cluster = "devnet";
      } else if (this.chainConfig?.chainId === "0x3") {
        cluster = "testnet";
      } else {
        throw WalletLoginError.connectionError(
          "Invalid chainId, demon doesn't support custom solana networks"
        );
      }
      const wallet = new DemonWalletAdapter({ network: cluster });
      if (!wallet.connected) {
        try {
          await wallet.connect();
        } catch (error: unknown) {
          if (error instanceof Web3AuthError) throw error;
          throw WalletLoginError.connectionError((error as Error)?.message);
        }
      }
      await this.connectWithProvider(wallet as DemonWallet);

      this._wallet = wallet;

      if (!wallet.publicKey) throw WalletLoginError.connectionError();
      wallet.on("disconnect", this._onDisconnect);

      return this.provider;
    } catch (error: unknown) {
      // ready again to be connected
      this.status = ADAPTER_STATUS.READY;
      this.rehydrated = false;
      this.emit(ADAPTER_EVENTS.ERRORED, error);
      throw error;
    }
  }

  async disconnect(
    options: { cleanup: boolean } = { cleanup: false }
  ): Promise<void> {
    await await super.disconnectSession();
    try {
      await this._wallet?.disconnect();
      if (options.cleanup) {
        this.status = ADAPTER_STATUS.NOT_READY;
        this.demonProvider = null;
        this._wallet = null;
      } else {
        this.status = ADAPTER_STATUS.READY;
      }
      await super.disconnect();
    } catch (error: unknown) {
      this.emit(
        ADAPTER_EVENTS.ERRORED,
        WalletLoginError.disconnectionError((error as Error)?.message)
      );
    }
  }

  async getUserInfo(): Promise<Partial<UserInfo>> {
    if (!this.isWalletConnected)
      throw WalletLoginError.notConnectedError(
        "Not connected with wallet, Please login/connect first"
      );
    return {};
  }

  public async addChain(
    chainConfig: CustomChainConfig,
    init = false
  ): Promise<void> {
    super.checkAddChainRequirements(init);
    this.demonProvider?.addChain(chainConfig);
    this.addChainConfig(chainConfig);
  }

  public async switchChain(
    params: { chainId: string },
    init = false
  ): Promise<void> {
    super.checkSwitchChainRequirements(params, init);
    await this.demonProvider?.switchChain(params);
    this.setAdapterSettings({
      chainConfig: this.getChainConfig(params.chainId) as CustomChainConfig,
    });
  }

  private async connectWithProvider(
    injectedProvider: DemonWallet
  ): Promise<SafeEventEmitterProvider | null> {
    if (!this.demonProvider)
      throw WalletLoginError.connectionError("No demon provider");
    await this.demonProvider.setupProvider(injectedProvider);
    this.status = ADAPTER_STATUS.CONNECTED;
    this.emit(ADAPTER_EVENTS.CONNECTED, {
      adapter: 'DEMON',
      reconnected: this.rehydrated,
    } as CONNECTED_EVENT_DATA);
    return this.provider;
  }

  private _onDisconnect = () => {
    if (this._wallet) {
      this._wallet.off("disconnect", this._onDisconnect);
      this.rehydrated = false;
      // ready to be connected again only if it was previously connected and not cleaned up
      this.status =
        this.status === ADAPTER_STATUS.CONNECTED
          ? ADAPTER_STATUS.READY
          : ADAPTER_STATUS.NOT_READY;
      this.emit(ADAPTER_EVENTS.DISCONNECTED);
    }
  };
}
