export * from "./compression.js";
// Solo la cara pública de la compactación de la cola: la selección sobre los
// mensajes es del pipeline y no forma parte del contrato.
export {
  compactToolOutput,
  COMPACTION_TRANSFORMS,
  DEFAULT_MIN_SAVED_CHARS,
  type CompactionTransform,
  type ToolOutputCompaction,
  type ToolOutputCompactionSettings,
} from "./cola.js";
