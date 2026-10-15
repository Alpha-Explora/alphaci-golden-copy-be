import { Inject, Injectable, Optional } from '@nestjs/common';
import type { DeploymentHistorySource } from '../application/ports/deployment-history-source.port';

export const DEPLOYMENT_HISTORY_SOURCES = Symbol('DeploymentHistorySources');

@Injectable()
export class DeploymentHistorySourceRegistry {
  private readonly sources = new Map<string, DeploymentHistorySource>();

  constructor(
    @Optional()
    @Inject(DEPLOYMENT_HISTORY_SOURCES)
    sources: readonly DeploymentHistorySource[] = [],
  ) {
    for (const source of sources) {
      if (this.sources.has(source.provider)) {
        throw new Error(`Duplicate history source: ${source.provider}`);
      }
      this.sources.set(source.provider, source);
    }
  }

  find(provider: string): DeploymentHistorySource | undefined {
    return this.sources.get(provider);
  }
}
