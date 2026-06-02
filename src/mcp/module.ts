import { registerWordPressPrimitives } from "./registry";

export function createWordPressModule() {
  return {
    registerCapabilities: registerWordPressPrimitives,
  };
}
