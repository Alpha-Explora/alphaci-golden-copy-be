import type { AssignmentRequestConfig } from '#kernel/ports/onprem-assignment.port';

/**
 * One repository's part of a host assignment chosen for a two-repository
 * project.
 *
 * The client sends one config per environment, with a port and a health
 * entry for each slot. Each repository of the pair is its own project with
 * its own environments and deploys one slot, and an assignment must name
 * exactly the slots of its environment's targets, so each row is assigned
 * with only its own slot's port and health entry. The ingress is shared by
 * both rows. Host ports are never part of a request: the server allocates
 * them per machine, so the two rows cannot collide on the same host.
 */
export function assignmentConfigForSlot(
  config: AssignmentRequestConfig,
  slot: 'backend' | 'frontend',
): AssignmentRequestConfig {
  return {
    ...config,
    ports: (config.ports ?? []).filter((port) => port?.slot === slot),
    health: (config.health ?? []).filter((health) => health?.slot === slot),
  };
}
