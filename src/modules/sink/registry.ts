import type { SinkType, SinkConnectorFactory } from "./types.js";

const REGISTRY = new Map<SinkType, SinkConnectorFactory>();

export function registerSinkConnector(type: SinkType, factory: SinkConnectorFactory): void {
  REGISTRY.set(type, factory);
}

export function getSinkConnectorFactory(type: SinkType): SinkConnectorFactory {
  const factory = REGISTRY.get(type);
  if (!factory) {
    throw new Error(`Unsupported sink type: ${type}`);
  }
  return factory;
}
