/**
 * Barrel for the inference module. Everything external consumers need
 * is re-exported here so they can `import { ... } from "../inference"`.
 */

export { OllamaAdapter } from "./ollama";
export { HTTPAdapter } from "./http";
export { InferenceRegistry, loadModelsYaml } from "./registry";
export type { ResolvedAdapter } from "./registry";
export { AdapterError } from "./adapter";
export type {
  InferenceAdapter,
  InferenceInvokeParams,
  InferenceResult,
  ModelConfig,
} from "./adapter";
