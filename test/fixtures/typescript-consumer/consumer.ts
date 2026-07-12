import {
	CONTRACT_VERSION,
	createStrictStageRequest,
	packageName,
} from "@bearmaxdd/omp-custom";

const publicContract: readonly [
	typeof CONTRACT_VERSION,
	typeof packageName,
	typeof createStrictStageRequest,
] = [CONTRACT_VERSION, packageName, createStrictStageRequest];

void publicContract;
