/** Durable, asynchronous memory for value constraints learned from prior responses. */
export interface ConstraintMemoryStore {
  has(key: string): Promise<boolean>;
  remember(key: string): Promise<void>;
}
