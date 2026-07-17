/**
 * @bearmaxdd/omp-compliance — OMP Advisor Compliance Extension
 *
 * Provides compliance checking, task completion tracking, and
 * repository standard enforcement for Oh My Pi projects.
 */

// The extension activation function is the primary entry point
export { default as activate } from "./extension";
export { assertAdvisorProtocolV1, PROTOCOL_V1_REQUIRED_ERROR } from "./activation/capability-negotiation";
export { createProjectContext, type ProjectContext } from "./project/project-context";
export {
	normalizeRemoteIdentity,
	PROJECT_IDENTITY_INVALID_ERROR,
	ProjectIdentityStore,
	type ProjectBinding,
	type ProjectBindingStatus,
	type ProjectIdentityOpenOptions,
	type ProjectIdentityResult,
} from "./project/project-identity";
