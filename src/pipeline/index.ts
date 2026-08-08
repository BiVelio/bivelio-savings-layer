export * from "./config.js";
export * from "./defaults.js";
// pipeline.js NO se reexporta: expone SavingsPipeline y su generateOptimized(),
// que corre el cascade sin pasar por el gate de licencia. Se importa directo
// donde de verdad hace falta (create.ts, tests).
export * from "./create.js";
