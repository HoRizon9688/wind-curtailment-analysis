/** Structured business errors; location is added only when actually known. */
export class CalculationError extends Error {
  constructor(code,message,location={}) {
    super(message);this.name='CalculationError';this.code=code;Object.assign(this,location);
  }
}
