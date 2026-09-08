/**
 * Contribution of the quality-stage jobs for one project stack.
 *
 * The generator previously chose these jobs with a boolean: `isBackend` picked
 * between two reusable workflows, and the type-check job was written inline
 * against Node. Both are correct only while every stack runs on Node, and both
 * fail by omission rather than by error when one does not — an unlisted stack
 * was classified as a frontend and handed `setup-node`.
 *
 * This mirrors the deployment provider contract in `workflow-fragment.port.ts`,
 * for the same reason and with the same shape: a key, and a method returning
 * jobs. Adding a stack becomes a registration rather than another branch in a
 * conditional. See ADR-0006.
 *
 * Sonar is deliberately not part of this contract. `sonarcloud-scan.yml` has no
 * toolchain coupling at all, so every stack shares one job rather than each
 * fragment restating it.
 */

/** What a fragment needs to know to build its jobs. */
export interface ToolchainFragmentContext {
  readonly serviceName: string;
  readonly servicePath: string;
  /**
   * Version of the stack's runtime — a Node major today, a target framework for
   * a compiled stack. Named for the axis rather than the toolchain, because the
   * value it carried was called `nodeVersion` everywhere and that is exactly the
   * assumption this contract removes.
   */
  readonly runtimeVersion: string;
  /**
   * Git ref of the central workflow repository, appended after `@` on every
   * `uses:`. The repository half is resolved by the fragment from the same
   * kernel config the rest of the pipeline uses, so the two cannot disagree.
   *
   * The coverage threshold is deliberately absent: it is decided at runtime by
   * the policy job and read from its outputs, so a fragment that took it as a
   * build-time number would be encoding a value the pipeline overrides.
   */
  readonly centralWorkflowRef: string;
  /**
   * Git ref expression the jobs check out. Passed in rather than rebuilt so a
   * fragment cannot disagree with the rest of the pipeline about which commit is
   * under test.
   */
  readonly checkoutRef: string;
  /**
   * True when the repository carries the ALPHACI scaffold's tests/ directory.
   * Undefined for repositories whose layout is unknown, where a fragment should
   * fall back to something every layout has.
   */
  readonly hasTestsDirectory: boolean | undefined;
  /**
   * `if:` expression restricting the package build to the promotion branches.
   *
   * Supplied by the pipeline rather than rebuilt per fragment: which branches
   * exist is the pipeline's decision, and a fragment that spelled the list out
   * would silently stop building on a branch when that list changed.
   */
  readonly buildBranchCondition: string;
  /** Job every quality job waits on, so policy outputs are resolved first. */
  readonly policyJobId: string;
  /** Job the access gate publishes, for jobs that depend on entitlement. */
  readonly accessJobId: string;
}

export interface ToolchainFragmentResult {
  /** Quality-stage jobs, keyed by job id. */
  readonly qualityJobs: Record<string, unknown>;
  /** The same job ids, in the order the reporting job should wait on them. */
  readonly qualityJobIds: string[];
  /**
   * Id of the job that produces coverage.
   *
   * Sonar consumes the coverage artifact, so it has to wait on whichever job
   * produced it — and that job's name differs per stack. Returning it here keeps
   * the caller from having to know the fragment's internal job names.
   */
  readonly testJobId: string;
  /**
   * The package stage's `build` job.
   *
   * Part of the toolchain rather than the pipeline because compiling is as
   * language-specific as testing is: the job was written inline against
   * `setup-node` and `npm ci`, which a .NET repository has no answer for. Every
   * provider deploy job depends on `build`, so a fragment cannot decline to
   * supply one without breaking the deployment graph.
   */
  readonly packageBuildJob: Record<string, unknown>;
}

export interface ToolchainFragment {
  /** Catalog stack key this fragment serves, as declared in stacks.json. */
  readonly stack: string;
  build(context: ToolchainFragmentContext): ToolchainFragmentResult;
}

export const TOOLCHAIN_FRAGMENTS = Symbol('ToolchainFragments');

export class ToolchainFragmentRegistry {
  private readonly fragmentsByStack = new Map<string, ToolchainFragment>();

  constructor(fragments: readonly ToolchainFragment[] = []) {
    fragments.forEach((fragment) => this.register(fragment));
  }

  register(fragment: ToolchainFragment): void {
    if (!fragment.stack.trim()) {
      throw new Error('Toolchain fragments must register a non-empty stack');
    }
    if (this.fragmentsByStack.has(fragment.stack)) {
      throw new Error(`Duplicate toolchain fragment stack: ${fragment.stack}`);
    }
    this.fragmentsByStack.set(fragment.stack, fragment);
  }

  get(stack: string): ToolchainFragment | undefined {
    return this.fragmentsByStack.get(stack);
  }

  /**
   * Build the quality jobs for a stack.
   *
   * Throws rather than returning undefined for an unregistered stack. The
   * provider registry can reasonably return nothing — a project may have no
   * deployment target — but a pipeline with no quality stage is never what was
   * asked for, and silently emitting one was how an unsupported stack produced a
   * green run that tested nothing.
   */
  build(
    stack: string,
    context: ToolchainFragmentContext,
  ): ToolchainFragmentResult {
    const fragment = this.fragmentsByStack.get(stack);
    if (!fragment) {
      throw new Error(
        `No toolchain registered for stack '${stack}'. Registered: ${[...this.fragmentsByStack.keys()].join(', ') || 'none'}.`,
      );
    }

    return fragment.build(context);
  }
}
