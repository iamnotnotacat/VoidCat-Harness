import { randomUUID } from "node:crypto";

export type ToolJsonPrimitive = string | number | boolean | null;
export type ToolJsonValue = ToolJsonPrimitive | ToolJsonValue[] | { [key: string]: ToolJsonValue };

export type ToolJsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  title?: string;
  description?: string;
  properties?: Record<string, ToolJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ToolJsonSchema;
  enum?: ToolJsonValue[];
  const?: ToolJsonValue;
  anyOf?: ToolJsonSchema[];
  oneOf?: ToolJsonSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
};

export type ToolInvocationCost = {
  externalCalls: number;
  inputTokens: number;
  outputTokens: number;
  units: number;
};

export type ToolInvocationCaller = {
  kind: "agent" | "user" | "system";
  id?: string;
  modelLane?: string;
};

export type ToolInvocationContext = {
  invocationId: string;
  signal: AbortSignal;
  caller: Readonly<ToolInvocationCaller>;
  reportCost(delta: Partial<ToolInvocationCost>): void;
};

export type ToolRateLimit = {
  invocations: number;
  windowMs: number;
  maxConcurrent?: number;
};

export type ToolDefinition<TArguments extends Record<string, unknown> = Record<string, unknown>, TResult = ToolJsonValue> = {
  name: string;
  module: string;
  description: string;
  inputSchema: ToolJsonSchema;
  outputSchema?: ToolJsonSchema;
  rateLimit: ToolRateLimit;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  tags?: string[];
  enabled?: boolean;
  handler(argumentsValue: Readonly<TArguments>, context: ToolInvocationContext): Promise<TResult> | TResult;
};

export type DiscoveredTool = Omit<ToolDefinition, "handler"> & {
  enabled: boolean;
};

export type ToolInvocationRecord = {
  invocationId: string;
  toolName: string;
  module: string;
  caller: ToolInvocationCaller;
  status: "success" | "error" | "rejected" | "rate-limited" | "cancelled";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
  cost: ToolInvocationCost;
  errorCode?: ToolRegistryErrorCode;
};

export type ToolRegistryErrorCode =
  | "TOOL_NOT_FOUND"
  | "TOOL_DISABLED"
  | "INVALID_ARGUMENTS"
  | "INVALID_RESULT"
  | "INPUT_TOO_LARGE"
  | "OUTPUT_TOO_LARGE"
  | "RATE_LIMITED"
  | "CONCURRENCY_LIMITED"
  | "CANCELLED"
  | "HANDLER_FAILED";

export class ToolRegistryError extends Error {
  readonly code: ToolRegistryErrorCode;
  readonly retryAt?: string;

  constructor(code: ToolRegistryErrorCode, message: string, options: { retryAt?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ToolRegistryError";
    this.code = code;
    this.retryAt = options.retryAt;
  }
}

type RegisteredTool = {
  definition: ToolDefinition;
  enabled: boolean;
  invocationTimes: number[];
  concurrent: number;
};

type ToolRegistryOptions = {
  now?: () => number;
  maximumRecords?: number;
  defaultMaxInputBytes?: number;
  defaultMaxOutputBytes?: number;
};

type DiscoveryFilter = {
  module?: string;
  tags?: string[];
  includeDisabled?: boolean;
};

type InvocationRecordFilter = {
  toolName?: string;
  module?: string;
  limit?: number;
};

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const MODULE_NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const ABSOLUTE_MAX_INPUT_BYTES = 1024 * 1024;
const ABSOLUTE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAXIMUM_RECORDS = 1_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonBytes(value: unknown) {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { throw new ToolRegistryError("INVALID_ARGUMENTS", "Tool data must be JSON serializable."); }
  if (serialized === undefined) throw new ToolRegistryError("INVALID_ARGUMENTS", "Tool data must be JSON serializable.");
  return Buffer.byteLength(serialized);
}

function sameJsonValue(left: unknown, right: unknown) {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
}

function validateSchemaDefinition(schema: ToolJsonSchema, path = "schema", depth = 0): string[] {
  if (depth > 20) return [`${path} exceeds the maximum schema depth.`];
  if (!isPlainObject(schema)) return [`${path} must be an object.`];
  const issues: string[] = [];
  if (!schema.type && schema.const === undefined && !schema.enum?.length && !schema.anyOf?.length && !schema.oneOf?.length) {
    issues.push(`${path} must declare a type, const, enum, anyOf, or oneOf.`);
  }
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) issues.push(`${path} object schemas must set additionalProperties to false.`);
    if (!schema.properties || !isPlainObject(schema.properties)) issues.push(`${path} object schemas require properties.`);
    else Object.entries(schema.properties).forEach(([key, child]) => issues.push(...validateSchemaDefinition(child, `${path}.properties.${key}`, depth + 1)));
    if (schema.required && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string" || !(key in (schema.properties ?? {}))))) {
      issues.push(`${path}.required must contain only declared property names.`);
    }
  }
  if (schema.type === "array") {
    if (!schema.items) issues.push(`${path} array schemas require items.`);
    else issues.push(...validateSchemaDefinition(schema.items, `${path}.items`, depth + 1));
    if (!Number.isInteger(schema.maxItems) || (schema.maxItems ?? 0) < 0) issues.push(`${path} array schemas require a non-negative maxItems.`);
  }
  if (schema.pattern !== undefined) {
    try { new RegExp(schema.pattern); } catch { issues.push(`${path}.pattern is not a valid regular expression.`); }
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || (schema[key] ?? 0) < 0)) issues.push(`${path}.${key} must be a non-negative integer.`);
  }
  for (const key of ["minimum", "maximum"] as const) {
    if (schema[key] !== undefined && !Number.isFinite(schema[key])) issues.push(`${path}.${key} must be finite.`);
  }
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) issues.push(`${path}.minLength cannot exceed maxLength.`);
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) issues.push(`${path}.minItems cannot exceed maxItems.`);
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) issues.push(`${path}.minimum cannot exceed maximum.`);
  if (schema.anyOf) {
    if (!schema.anyOf.length) issues.push(`${path}.anyOf must not be empty.`);
    schema.anyOf.forEach((child, index) => issues.push(...validateSchemaDefinition(child, `${path}.anyOf[${index}]`, depth + 1)));
  }
  if (schema.oneOf) {
    if (!schema.oneOf.length) issues.push(`${path}.oneOf must not be empty.`);
    schema.oneOf.forEach((child, index) => issues.push(...validateSchemaDefinition(child, `${path}.oneOf[${index}]`, depth + 1)));
  }
  return issues;
}

function validateValue(value: unknown, schema: ToolJsonSchema, path = "$", depth = 0): string[] {
  if (depth > 30) return [`${path} exceeds the maximum value depth.`];
  if (schema.const !== undefined && !sameJsonValue(value, schema.const)) return [`${path} does not match the required constant.`];
  if (schema.enum && !schema.enum.some((candidate) => sameJsonValue(value, candidate))) return [`${path} is not an allowed value.`];
  if (schema.anyOf) {
    const matches = schema.anyOf.filter((candidate) => validateValue(value, candidate, path, depth + 1).length === 0);
    if (!matches.length) return [`${path} does not match any allowed schema.`];
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validateValue(value, candidate, path, depth + 1).length === 0);
    if (matches.length !== 1) return [`${path} must match exactly one allowed schema.`];
  }

  switch (schema.type) {
    case "null": return value === null ? [] : [`${path} must be null.`];
    case "boolean": return typeof value === "boolean" ? [] : [`${path} must be a boolean.`];
    case "string": {
      if (typeof value !== "string") return [`${path} must be a string.`];
      if (schema.minLength !== undefined && value.length < schema.minLength) return [`${path} is shorter than ${schema.minLength} characters.`];
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return [`${path} is longer than ${schema.maxLength} characters.`];
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) return [`${path} does not match the required pattern.`];
      return [];
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) return [`${path} must be a finite ${schema.type}.`];
      if (schema.minimum !== undefined && value < schema.minimum) return [`${path} must be at least ${schema.minimum}.`];
      if (schema.maximum !== undefined && value > schema.maximum) return [`${path} must be at most ${schema.maximum}.`];
      return [];
    }
    case "array": {
      if (!Array.isArray(value)) return [`${path} must be an array.`];
      if (schema.minItems !== undefined && value.length < schema.minItems) return [`${path} requires at least ${schema.minItems} items.`];
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return [`${path} allows at most ${schema.maxItems} items.`];
      return schema.items ? value.flatMap((item, index) => validateValue(item, schema.items!, `${path}[${index}]`, depth + 1)) : [];
    }
    case "object": {
      if (!isPlainObject(value)) return [`${path} must be an object.`];
      const properties = schema.properties ?? {};
      const issues: string[] = [];
      for (const key of schema.required ?? []) if (!(key in value)) issues.push(`${path}.${key} is required.`);
      for (const [key, childValue] of Object.entries(value)) {
        if (!properties[key]) {
          if (schema.additionalProperties === false) issues.push(`${path}.${key} is not allowed.`);
          continue;
        }
        issues.push(...validateValue(childValue, properties[key], `${path}.${key}`, depth + 1));
      }
      return issues;
    }
    default: return [];
  }
}

function validateDefinition(definition: ToolDefinition) {
  const issues: string[] = [];
  if (!TOOL_NAME_PATTERN.test(definition.name)) issues.push("tool name must be a lowercase, dot-namespaced identifier");
  if (!MODULE_NAME_PATTERN.test(definition.module)) issues.push("module must be a lowercase identifier between 2 and 64 characters");
  if (definition.description.trim().length < 20 || definition.description.length > 1_000) issues.push("description must contain between 20 and 1,000 characters");
  if (definition.inputSchema.type !== "object") issues.push("inputSchema root type must be object");
  issues.push(...validateSchemaDefinition(definition.inputSchema, "inputSchema"));
  if (definition.outputSchema) issues.push(...validateSchemaDefinition(definition.outputSchema, "outputSchema"));
  if (!Number.isInteger(definition.rateLimit.invocations) || definition.rateLimit.invocations < 1) issues.push("rateLimit.invocations must be a positive integer");
  if (!Number.isInteger(definition.rateLimit.windowMs) || definition.rateLimit.windowMs < 1_000) issues.push("rateLimit.windowMs must be at least 1,000 milliseconds");
  if (definition.rateLimit.maxConcurrent !== undefined && (!Number.isInteger(definition.rateLimit.maxConcurrent) || definition.rateLimit.maxConcurrent < 1)) issues.push("rateLimit.maxConcurrent must be a positive integer");
  if (definition.tags?.some((tag) => !/^[a-z][a-z0-9-]{0,31}$/.test(tag))) issues.push("tags must be lowercase identifiers no longer than 32 characters");
  if (definition.maxInputBytes !== undefined && (!Number.isInteger(definition.maxInputBytes) || definition.maxInputBytes < 1 || definition.maxInputBytes > ABSOLUTE_MAX_INPUT_BYTES)) issues.push(`maxInputBytes must be between 1 and ${ABSOLUTE_MAX_INPUT_BYTES}`);
  if (definition.maxOutputBytes !== undefined && (!Number.isInteger(definition.maxOutputBytes) || definition.maxOutputBytes < 1 || definition.maxOutputBytes > ABSOLUTE_MAX_OUTPUT_BYTES)) issues.push(`maxOutputBytes must be between 1 and ${ABSOLUTE_MAX_OUTPUT_BYTES}`);
  if (issues.length) throw new Error(`Invalid tool definition ${definition.name || "<unnamed>"}: ${issues.join("; ")}.`);
}

function cloneSchema(schema: ToolJsonSchema): ToolJsonSchema {
  return structuredClone(schema);
}

function normalizeCostDelta(delta: Partial<ToolInvocationCost>) {
  const result: Partial<ToolInvocationCost> = {};
  for (const key of ["externalCalls", "inputTokens", "outputTokens", "units"] as const) {
    const value = delta[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) throw new Error(`Tool cost ${key} must be a non-negative finite number.`);
    result[key] = value;
  }
  return result;
}

function normalizeCaller(value: ToolInvocationCaller | undefined): Readonly<ToolInvocationCaller> {
  const caller = value ?? { kind: "system" as const };
  if (!(["agent", "user", "system"] as const).includes(caller.kind)) throw new ToolRegistryError("INVALID_ARGUMENTS", "Tool caller kind is invalid.");
  if (caller.id !== undefined && (typeof caller.id !== "string" || !caller.id.trim() || caller.id.length > 128)) throw new ToolRegistryError("INVALID_ARGUMENTS", "Tool caller id must contain 1 to 128 characters.");
  if (caller.modelLane !== undefined && (typeof caller.modelLane !== "string" || !caller.modelLane.trim() || caller.modelLane.length > 64)) throw new ToolRegistryError("INVALID_ARGUMENTS", "Tool model lane must contain 1 to 64 characters.");
  return Object.freeze({
    kind: caller.kind,
    id: caller.id?.trim(),
    modelLane: caller.modelLane?.trim(),
  });
}

export class VoidCatToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly records: ToolInvocationRecord[] = [];
  private readonly now: () => number;
  private readonly maximumRecords: number;
  private readonly defaultMaxInputBytes: number;
  private readonly defaultMaxOutputBytes: number;

  constructor(options: ToolRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maximumRecords = Math.max(1, Math.min(10_000, Math.round(options.maximumRecords ?? DEFAULT_MAXIMUM_RECORDS)));
    this.defaultMaxInputBytes = Math.max(1_024, Math.min(ABSOLUTE_MAX_INPUT_BYTES, Math.round(options.defaultMaxInputBytes ?? DEFAULT_MAX_INPUT_BYTES)));
    this.defaultMaxOutputBytes = Math.max(1_024, Math.min(ABSOLUTE_MAX_OUTPUT_BYTES, Math.round(options.defaultMaxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)));
  }

  register<TArguments extends Record<string, unknown>, TResult>(definition: ToolDefinition<TArguments, TResult>) {
    validateDefinition(definition as ToolDefinition);
    if (this.tools.has(definition.name)) throw new Error(`Tool ${definition.name} is already registered.`);
    this.tools.set(definition.name, {
      definition: definition as ToolDefinition,
      enabled: definition.enabled !== false,
      invocationTimes: [],
      concurrent: 0,
    });
    return () => this.unregister(definition.name);
  }

  unregister(name: string) {
    const registered = this.tools.get(name);
    if (registered?.concurrent) throw new Error(`Tool ${name} cannot be unregistered while it is running.`);
    return this.tools.delete(name);
  }

  setEnabled(name: string, enabled: boolean) {
    const tool = this.requireTool(name);
    tool.enabled = enabled;
  }

  discover(filter: DiscoveryFilter = {}): DiscoveredTool[] {
    const requestedTags = new Set(filter.tags ?? []);
    return [...this.tools.values()]
      .filter(({ definition, enabled }) => (filter.includeDisabled || enabled)
        && (!filter.module || definition.module === filter.module)
        && (!requestedTags.size || [...requestedTags].every((tag) => definition.tags?.includes(tag))))
      .sort((left, right) => left.definition.name.localeCompare(right.definition.name))
      .map(({ definition, enabled }) => ({
        name: definition.name,
        module: definition.module,
        description: definition.description,
        inputSchema: cloneSchema(definition.inputSchema),
        outputSchema: definition.outputSchema ? cloneSchema(definition.outputSchema) : undefined,
        rateLimit: { ...definition.rateLimit },
        maxInputBytes: definition.maxInputBytes ?? this.defaultMaxInputBytes,
        maxOutputBytes: definition.maxOutputBytes ?? this.defaultMaxOutputBytes,
        tags: definition.tags ? [...definition.tags] : undefined,
        enabled,
      }));
  }

  invocationRecords(filter: InvocationRecordFilter = {}) {
    const limit = Math.max(0, Math.min(this.maximumRecords, Math.round(filter.limit ?? this.maximumRecords)));
    if (limit === 0) return [];
    return this.records
      .filter((record) => (!filter.toolName || record.toolName === filter.toolName) && (!filter.module || record.module === filter.module))
      .slice(-limit)
      .map((record) => structuredClone(record));
  }

  clearInvocationRecords() {
    this.records.length = 0;
  }

  async invoke<TResult = ToolJsonValue>(name: string, argumentsValue: Record<string, unknown>, options: { caller?: ToolInvocationCaller; signal?: AbortSignal } = {}): Promise<TResult> {
    const tool = this.requireTool(name);
    const startedMs = this.now();
    const invocationId = randomUUID();
    const caller = normalizeCaller(options.caller);
    let inputBytes = 0;
    const cost: ToolInvocationCost = { externalCalls: 0, inputTokens: 0, outputTokens: 0, units: 0 };
    const makeRecord = (status: ToolInvocationRecord["status"], outputBytes: number, errorCode?: ToolRegistryErrorCode) => {
      const completedMs = this.now();
      this.record({
        invocationId,
        toolName: name,
        module: tool.definition.module,
        caller,
        status,
        startedAt: new Date(startedMs).toISOString(),
        completedAt: new Date(completedMs).toISOString(),
        durationMs: Math.max(0, completedMs - startedMs),
        inputBytes,
        outputBytes,
        cost: { ...cost },
        errorCode,
      });
    };

    try {
      if (!tool.enabled) throw new ToolRegistryError("TOOL_DISABLED", `Tool ${name} is disabled.`);
      if (!isPlainObject(argumentsValue)) throw new ToolRegistryError("INVALID_ARGUMENTS", "Tool arguments must be an object.");
      inputBytes = jsonBytes(argumentsValue);
      const maximumInputBytes = Math.max(1, Math.min(ABSOLUTE_MAX_INPUT_BYTES, tool.definition.maxInputBytes ?? this.defaultMaxInputBytes));
      if (inputBytes > maximumInputBytes) throw new ToolRegistryError("INPUT_TOO_LARGE", `Tool arguments exceed the ${maximumInputBytes}-byte limit.`);
      const argumentIssues = validateValue(argumentsValue, tool.definition.inputSchema);
      if (argumentIssues.length) throw new ToolRegistryError("INVALID_ARGUMENTS", `Tool arguments failed validation: ${argumentIssues.slice(0, 5).join(" ")}`);
      if (options.signal?.aborted) throw new ToolRegistryError("CANCELLED", `Tool ${name} was cancelled before invocation.`);

      const currentTime = this.now();
      tool.invocationTimes = tool.invocationTimes.filter((timestamp) => timestamp > currentTime - tool.definition.rateLimit.windowMs);
      if (tool.invocationTimes.length >= tool.definition.rateLimit.invocations) {
        const retryAt = new Date(tool.invocationTimes[0] + tool.definition.rateLimit.windowMs).toISOString();
        throw new ToolRegistryError("RATE_LIMITED", `Tool ${name} reached its invocation limit.`, { retryAt });
      }
      if (tool.concurrent >= (tool.definition.rateLimit.maxConcurrent ?? 1)) {
        throw new ToolRegistryError("CONCURRENCY_LIMITED", `Tool ${name} reached its concurrency limit.`);
      }

      tool.invocationTimes.push(currentTime);
      tool.concurrent += 1;
      let acceptingCost = true;
      try {
        const signal = options.signal ?? new AbortController().signal;
        const result = await tool.definition.handler(Object.freeze(structuredClone(argumentsValue)), {
          invocationId,
          signal,
          caller,
          reportCost(delta) {
            if (!acceptingCost) throw new Error("Tool cost cannot be reported after the handler completes.");
            const normalized = normalizeCostDelta(delta);
            for (const key of Object.keys(normalized) as Array<keyof ToolInvocationCost>) cost[key] += normalized[key] ?? 0;
          },
        });
        acceptingCost = false;
        if (signal.aborted) throw new ToolRegistryError("CANCELLED", `Tool ${name} was cancelled.`);
        let outputBytes: number;
        try { outputBytes = jsonBytes(result); }
        catch (error) { throw new ToolRegistryError("INVALID_RESULT", `Tool ${name} returned a non-JSON result.`, { cause: error }); }
        const maximumOutputBytes = Math.max(1, Math.min(ABSOLUTE_MAX_OUTPUT_BYTES, tool.definition.maxOutputBytes ?? this.defaultMaxOutputBytes));
        if (outputBytes > maximumOutputBytes) throw new ToolRegistryError("OUTPUT_TOO_LARGE", `Tool ${name} returned more than ${maximumOutputBytes} bytes.`);
        if (tool.definition.outputSchema) {
          const resultIssues = validateValue(result, tool.definition.outputSchema);
          if (resultIssues.length) throw new ToolRegistryError("INVALID_RESULT", `Tool ${name} returned an invalid result.`);
        }
        makeRecord("success", outputBytes);
        return result as TResult;
      } finally {
        acceptingCost = false;
        tool.concurrent -= 1;
      }
    } catch (error) {
      const registryError = error instanceof ToolRegistryError
        ? error
        : new ToolRegistryError("HANDLER_FAILED", `Tool ${name} failed inside its handler.`, { cause: error });
      const status = registryError.code === "RATE_LIMITED" || registryError.code === "CONCURRENCY_LIMITED"
        ? "rate-limited"
        : registryError.code === "CANCELLED"
          ? "cancelled"
          : registryError.code === "HANDLER_FAILED" || registryError.code === "INVALID_RESULT" || registryError.code === "OUTPUT_TOO_LARGE"
            ? "error"
            : "rejected";
      makeRecord(status, 0, registryError.code);
      throw registryError;
    }
  }

  private requireTool(name: string) {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolRegistryError("TOOL_NOT_FOUND", `Tool ${name} is not registered.`);
    return tool;
  }

  private record(record: ToolInvocationRecord) {
    this.records.push(record);
    if (this.records.length > this.maximumRecords) this.records.splice(0, this.records.length - this.maximumRecords);
  }
}

/** Shared process-local registry used by every VoidCat model lane and module adapter. */
export const voidcatToolRegistry = new VoidCatToolRegistry();
