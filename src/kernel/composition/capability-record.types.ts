export type CapabilityMaturity = 'stable' | 'limited' | 'not-implemented';

export interface CapabilityRecord {
  readonly key: string;
  readonly context: string;
  readonly description: string;
  readonly maturity: CapabilityMaturity;
  readonly configuration: string;
  readonly configurationFlags: readonly string[];
  readonly requires: readonly string[];
}
