/** An error whose (masked) message is safe and useful to keep when a fatal violation stops the run. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}
