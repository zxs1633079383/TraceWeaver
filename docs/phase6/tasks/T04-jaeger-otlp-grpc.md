# T04 — OTel 多适配器 + OTLP/gRPC（Jaeger 接入）

**状态：** pending
**依赖：** 无（独立任务）

---

## 目标

实现可插拔 OTel 导出适配器系统，新增 OTLP/gRPC 适配器，通过配置接入 Jaeger（或任意 OTLP/gRPC 后端）。

## 现状分析

```
当前：
  OtlpExporter → OTLP/HTTP JSON → http://localhost:4318/v1/traces
  SpanManager.endSpan() 调用 OtlpExporter.export([span])

目标：
  ExporterRegistry                       ← 多适配器注册表
    ├── OtlpHttpExporter (已有，重命名)   ← port 4318, HTTP/JSON
    ├── OtlpGrpcExporter (新增)           ← port 4317, gRPC/proto
    └── ConsoleExporter  (新增)           ← 开发调试用

  SpanManager.endSpan() → ExporterRegistry.exportAll([span])
```

## 新增依赖

```json
"@grpc/grpc-js": "^1.10.0",
"@grpc/proto-loader": "^0.7.0"
```

## 架构

### TraceExporter 接口

```typescript
// src/otel/exporter-types.ts
export interface TraceExporter {
  readonly name: string
  export(spans: SpanMeta[]): Promise<void>
  shutdown?(): Promise<void>
}
```

### ExporterRegistry

```typescript
// src/otel/exporter-registry.ts
export class ExporterRegistry {
  register(exporter: TraceExporter): void
  async exportAll(spans: SpanMeta[]): Promise<void>  // Promise.allSettled — 一个失败不影响其他
  async shutdown(): Promise<void>
}
```

### OtlpGrpcExporter

```typescript
// src/otel/exporter-grpc.ts
export class OtlpGrpcExporter implements TraceExporter {
  readonly name = 'otlp-grpc'
  constructor(opts: { endpoint: string; headers?: Record<string,string>; enabled?: boolean })
  async export(spans: SpanMeta[]): Promise<void>
  async shutdown(): Promise<void>
}
```

## gRPC 实现细节

### Proto 文件位置

```
src/otel/proto/
  opentelemetry/proto/
    collector/trace/v1/trace_service.proto
    common/v1/common.proto
    resource/v1/resource.proto
    trace/v1/trace.proto
```

直接从 [opentelemetry-proto](https://github.com/open-telemetry/opentelemetry-proto) 复制。

### 核心调用

```typescript
const packageDef = protoLoader.loadSync(
  path.join(PROTO_DIR, 'opentelemetry/proto/collector/trace/v1/trace_service.proto'),
  {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    includeDirs: [PROTO_DIR],
  }
)
const { opentelemetry } = grpc.loadPackageDefinition(packageDef) as any
this.client = new opentelemetry.proto.collector.trace.v1.TraceService(
  endpoint.replace(/^https?:\/\//, ''),  // grpc-js 不要协议头
  grpc.credentials.createInsecure()
)
```

### Payload 格式（与 HTTP 版本相同的 OTLP JSON → proto 映射）

参考现有 `buildOtlpPayload()` 方法，转换为 proto message 格式。

### 错误隔离

```typescript
async export(spans: SpanMeta[]): Promise<void> {
  if (!this.enabled) return
  await new Promise<void>((resolve, reject) => {
    this.client.Export(payload, metadata, (err: Error | null) => {
      if (err) reject(err) else resolve()
    })
  })
  // 调用方 ExporterRegistry 使用 Promise.allSettled，此处 throw 不影响其他 exporter
}
```

## 环境变量映射

```
TW_OTEL_EXPORTER=otlp-grpc
TW_OTEL_ENDPOINT=http://jaeger-cses-pre-collector.jaeger-cses.svc.cluster.local:4317
```

Daemon index.ts 解析逻辑：
```typescript
const exporterNames = (process.env.TW_OTEL_EXPORTER ?? 'console').split(',')
const endpoint = process.env.TW_OTEL_ENDPOINT

for (const name of exporterNames) {
  if (name === 'console')   registry.register(new ConsoleExporter())
  if (name === 'otlp-http') registry.register(new OtlpHttpExporter({ endpoint }))
  if (name === 'otlp-grpc') registry.register(new OtlpGrpcExporter({ endpoint }))
}
```

## 验收

1. `TW_OTEL_EXPORTER=otlp-grpc TW_OTEL_ENDPOINT=http://jaeger:4317 tw daemon start`
2. 注册实体并完成流转
3. Jaeger UI → service=`traceweaver-daemon` → 可看到 span
4. span attributes 包含 `tw.entity.id`, `tw.entity.type`, `tw.project.id`
5. span events 对应状态变更（`state_changed_to_*`）

## 测试清单

- [ ] ExporterRegistry.exportAll 并行调用所有注册的 exporter
- [ ] 一个 exporter 失败不影响其他（allSettled）
- [ ] OtlpGrpcExporter 调用 gRPC Export 方法（mock client）
- [ ] disabled 时不调用 Export
- [ ] ConsoleExporter 输出到 stdout
