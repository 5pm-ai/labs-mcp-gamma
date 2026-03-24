import type { WarehouseType, ConnectorFactory } from "./types.js";

const REGISTRY = new Map<WarehouseType, ConnectorFactory>();

export function registerConnector(type: WarehouseType, factory: ConnectorFactory): void {
  REGISTRY.set(type, factory);
}

export function getConnectorFactory(type: WarehouseType): ConnectorFactory {
  const factory = REGISTRY.get(type);
  if (!factory) {
    throw new Error(`Unsupported warehouse type: ${type}`);
  }
  return factory;
}
