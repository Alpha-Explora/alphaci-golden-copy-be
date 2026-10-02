/**
 * Whether a Project has the requirements a Developer needs before creating a
 * repository in it. The Project's requirements (projects.qa_checklists) are
 * owned by the projects context; identity-access (the hierarchy repository
 * create and the project-folders listing) must not query projects.* and so
 * asks through this port.
 */
export interface ProjectRequirementsReadinessPort {
  /**
   * False when the `projects.qa-checklists` capability is off for this
   * deployment. Nobody can write Features then, so the Feature rule is skipped.
   */
  isFeatureRuleEnabled(): boolean;

  /**
   * Active Features (functional requirements, not archived) per Project, in
   * one batched query. Every requested id is present in the result (0 when the
   * Project has none, or when the capability is off).
   */
  countActiveFeatures(
    deliveryProjectIds: readonly string[],
  ): Promise<Map<string, number>>;
}

export const PROJECT_REQUIREMENTS_READINESS = Symbol(
  'ProjectRequirementsReadinessPort',
);
