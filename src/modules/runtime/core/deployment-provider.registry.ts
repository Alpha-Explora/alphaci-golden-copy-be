import { Injectable } from '@nestjs/common';

export interface RegisteredDeploymentProvider {
  readonly id: string;
}

@Injectable()
export class DeploymentProviderRegistry<
  Provider extends RegisteredDeploymentProvider = RegisteredDeploymentProvider,
> {
  private readonly providersById: Map<string, Provider>;

  constructor() {
    this.providersById = new Map();
  }

  register(provider: Provider): void {
    if (this.providersById.has(provider.id)) {
      throw new Error(`Duplicate deployment provider id: ${provider.id}`);
    }

    this.providersById.set(provider.id, provider);
  }

  get(id: string): Provider {
    const provider = this.providersById.get(id);
    if (!provider) {
      throw new Error(`Unknown deployment provider: ${id}`);
    }

    return provider;
  }

  find(id: string): Provider | undefined {
    return this.providersById.get(id);
  }

  list(): Provider[] {
    return [...this.providersById.values()];
  }
}
