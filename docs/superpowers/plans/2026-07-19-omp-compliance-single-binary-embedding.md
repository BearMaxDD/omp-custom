# OMP Compliance 单二进制内置实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `BearMaxDD/omp-custom` 以精确 Git Submodule commit 静态编译进 `BearMaxDD/oh-my-pi`，使单个 OMP v17 二进制在没有外部插件时始终启用完整 Advisor 合规能力。

**架构：** `oh-my-pi/vendor/omp-custom` 保存 gitlink，宿主内置扩展注册表直接导入 submodule 中的默认 ExtensionFactory，并在每个 Agent Session 中创建独立实例。编译器从已验证的 submodule 计算 commit、版本和源码 hash，通过 Bun `define` 注入二进制；外部同包名插件在执行前被过滤，`--no-extensions` 不能关闭内置合规层。

**技术栈：** TypeScript、Bun 1.3.14、Bun Build Compile、Git Submodule、Bun Test、Biome、Advisor Review Protocol v1。

**设计规格：** `docs/superpowers/specs/2026-07-19-omp-compliance-single-binary-embedding-design.md`

---

## 工作区与提交顺序

```bash
export EXT=/Users/mima1234/Code/super/.worktrees/omp-custom-v17-adapter
export HOST=/Users/mima1234/Code/super/.worktrees/oh-my-pi-v17-advisor-protocol
export SPEC=$EXT/docs/superpowers/specs/2026-07-19-omp-compliance-single-binary-embedding-design.md
```

必须先完成并推送任务 1、2 的 `omp-custom` commit，宿主才能创建指向远端可获取对象的 gitlink。任务 3 至任务 7 在 `oh-my-pi` 完成。任务 8 同时验证两个仓库，但不提交二进制。

## 文件结构

### `omp-custom`

- 创建 `packages/omp-compliance/src/embedding/build-identity.ts`：定义编译期身份常量与开发态回退。
- 创建 `packages/omp-compliance/test/embedding/build-identity.test.ts`：锁定身份格式、冻结和编译注入行为。
- 修改 `packages/omp-compliance/src/extension.ts`：向 Doctor 暴露内置身份和外部重复项状态。
- 修改 `packages/omp-compliance/src/host/extension-api.ts`：声明可选通用内置扩展上下文。
- 修改 `packages/omp-compliance/test/support/fake-extension-api.ts`：支持内置上下文测试。
- 修改 `packages/omp-compliance/package.json`：移除不可移植的本机绝对开发依赖。

### `oh-my-pi`

- 创建 `.gitmodules` 与 `vendor/omp-custom` gitlink：精确锁定扩展源码 commit。
- 创建 `scripts/embedded-compliance.ts`：验证 submodule 并计算确定性构建身份。
- 创建 `scripts/embedded-compliance.test.ts`：覆盖缺失、漂移、脏状态和 hash。
- 创建 `packages/coding-agent/src/extensibility/extensions/builtin.ts`：内置扩展描述符和静态 factory。
- 创建 `packages/coding-agent/src/extensibility/extensions/embedded-dedup.ts`：按 package identity 在执行前过滤旧插件。
- 创建 `packages/coding-agent/test/embedded-compliance-builtin.test.ts`：锁定不可关闭和 Session 独立实例。
- 修改 `packages/coding-agent/src/extensibility/extensions/types.ts`：公开通用 `EmbeddedExtensionContext`。
- 修改 `packages/coding-agent/src/extensibility/extensions/loader.ts`：向内置 factory 注入身份和去重诊断。
- 修改 `packages/coding-agent/src/sdk.ts`：统一加载内置 factory，并携带去重结果。
- 修改 `packages/coding-agent/test/extensions-discovery.test.ts`：覆盖显式路径与 package identity 去重。
- 修改 `packages/coding-agent/test/plugin-extensions-discovery.test.ts`：覆盖已安装旧插件不执行。
- 修改 `packages/coding-agent/scripts/compile-binary.ts`：将已验证身份注入 Bun `define`。
- 修改 `packages/coding-agent/scripts/build-binary.ts`：本地构建执行 submodule 前置检查。
- 修改 `scripts/ci-release-build-binaries.ts`：release 构建执行同一前置检查。
- 修改 `scripts/ci-release-build-binaries.test.ts`：锁定 dry-run 和构建身份。
- 修改 `.github/workflows/ci.yml`：所有需要 TypeScript 源码的 checkout 初始化 submodule。
- 修改 `README.md`，创建 `docs/omp-custom-embedding.md`：说明单文件运行和 submodule 更新。
- 创建 `scripts/accept-embedded-compliance-macos.sh`：macOS 新鲜 HOME 真实验收。
- 创建 `scripts/verify-embedded-compliance-linux.ts`：Linux ELF 和嵌入身份构建验收。

### 任务 1：建立可移植的扩展构建身份

**仓库：** `omp-custom`

**文件：**
- 创建：`packages/omp-compliance/src/embedding/build-identity.ts`
- 创建：`packages/omp-compliance/test/embedding/build-identity.test.ts`
- 修改：`packages/omp-compliance/package.json`

- [ ] **步骤 1：编写失败的身份测试**

```ts
import { describe, expect, it } from "bun:test";
import { embeddedComplianceBuildIdentity } from "../../src/embedding/build-identity";

describe("embedded compliance build identity", () => {
  it("开发态返回严格且冻结的身份", () => {
    const identity = embeddedComplianceBuildIdentity();
    expect(identity.packageName).toBe("@bearmaxdd/omp-compliance");
    expect(identity.protocol).toBe("advisor-review/v1");
    expect(identity.packageVersion).toBe("development");
    expect(identity.gitCommit).toBe("development");
    expect(identity.sourceHash).toBe("sha256:development");
    expect(Object.isFrozen(identity)).toBe(true);
  });
});
```

- [ ] **步骤 2：运行测试确认红灯**

```bash
cd "$EXT"
bun test packages/omp-compliance/test/embedding/build-identity.test.ts
```

预期：FAIL，错误为无法解析 `../../src/embedding/build-identity`。

- [ ] **步骤 3：实现最小身份模块**

```ts
declare const __OMP_COMPLIANCE_PACKAGE_VERSION__: string;
declare const __OMP_COMPLIANCE_GIT_COMMIT__: string;
declare const __OMP_COMPLIANCE_SOURCE_HASH__: string;

export interface EmbeddedComplianceBuildIdentity {
  readonly packageName: "@bearmaxdd/omp-compliance";
  readonly packageVersion: string;
  readonly gitCommit: string;
  readonly sourceHash: `sha256:${string}`;
  readonly protocol: "advisor-review/v1";
}

const defined = (value: string | undefined, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

export function embeddedComplianceBuildIdentity(): EmbeddedComplianceBuildIdentity {
  return Object.freeze({
    packageName: "@bearmaxdd/omp-compliance",
    packageVersion: defined(
      typeof __OMP_COMPLIANCE_PACKAGE_VERSION__ === "string"
        ? __OMP_COMPLIANCE_PACKAGE_VERSION__
        : undefined,
      "development",
    ),
    gitCommit: defined(
      typeof __OMP_COMPLIANCE_GIT_COMMIT__ === "string" ? __OMP_COMPLIANCE_GIT_COMMIT__ : undefined,
      "development",
    ),
    sourceHash: defined(
      typeof __OMP_COMPLIANCE_SOURCE_HASH__ === "string" ? __OMP_COMPLIANCE_SOURCE_HASH__ : undefined,
      "sha256:development",
    ) as `sha256:${string}`,
    protocol: "advisor-review/v1",
  });
}
```

从 `packages/omp-compliance/package.json` 删除包含 `/Users/mima1234/` 的 `@oh-my-pi/pi-coding-agent` devDependency；类型契约继续由仓库内 `src/host/extension-api.ts` 提供，peerDependency 保持 `>=17.0.1 <18`。

- [ ] **步骤 4：运行身份测试、构建与绝对路径扫描**

```bash
cd "$EXT"
bun test packages/omp-compliance/test/embedding/build-identity.test.ts
bun run build
! rg -n '/Users/mima1234|file:/Users/' package.json packages/omp-compliance/package.json bun.lock
```

预期：测试和构建退出码 0，扫描无输出。

- [ ] **步骤 5：提交**

```bash
cd "$EXT"
git add packages/omp-compliance/src/embedding/build-identity.ts \
  packages/omp-compliance/test/embedding/build-identity.test.ts \
  packages/omp-compliance/package.json bun.lock
git commit -m "功能：增加合规扩展嵌入构建身份"
```

### 任务 2：让 Doctor 验证内置身份与重复插件抑制

**仓库：** `omp-custom`

**文件：**
- 修改：`packages/omp-compliance/src/host/extension-api.ts`
- 修改：`packages/omp-compliance/src/extension.ts`
- 修改：`packages/omp-compliance/test/support/fake-extension-api.ts`
- 修改：`packages/omp-compliance/test/extension.test.ts`

- [ ] **步骤 1：编写失败的 Doctor 测试**

在 Fake API 上提供：

```ts
embeddedExtensionContext: {
  identity: {
    packageName: "@bearmaxdd/omp-compliance",
    packageVersion: "0.1.0",
    gitCommit: "a".repeat(40),
    sourceHash: `sha256:${"b".repeat(64)}`,
    protocol: "advisor-review/v1",
  },
  suppressedExternalDuplicates: ["@bearmaxdd/omp-compliance"],
}
```

断言日志同时包含：

```ts
expect(api.logs.some(line => line.includes("Doctor embedding: ready"))).toBe(true);
expect(api.logs.some(line => line.includes("Doctor source: ready"))).toBe(true);
expect(api.logs.some(line => line.includes("Doctor duplicate: ready"))).toBe(true);
```

再增加一个无 `embeddedExtensionContext` 的夹具，断言 `Doctor embedding: missing`。

- [ ] **步骤 2：运行测试确认红灯**

```bash
cd "$EXT"
bun test packages/omp-compliance/test/extension.test.ts
```

预期：FAIL，Doctor 尚未输出 embedding/source/duplicate。

- [ ] **步骤 3：扩展通用宿主上下文并实现 Doctor**

在 `src/host/extension-api.ts` 定义：

```ts
export interface EmbeddedExtensionContext {
  readonly identity: EmbeddedComplianceBuildIdentity;
  readonly suppressedExternalDuplicates: readonly string[];
}
```

在 `ComplianceExtensionHost` 增加只读可选属性：

```ts
readonly embeddedExtensionContext?: EmbeddedExtensionContext;
```

Doctor 必须按以下规则输出：

```ts
const embedding = api.embeddedExtensionContext;
const productionIdentity =
  embedding?.identity.packageName === "@bearmaxdd/omp-compliance" &&
  embedding.identity.protocol === "advisor-review/v1" &&
  /^[0-9a-f]{40}$/.test(embedding.identity.gitCommit) &&
  /^sha256:[0-9a-f]{64}$/.test(embedding.identity.sourceHash);
```

`productionIdentity` 为假时 embedding/source 均为 missing；为真时输出版本、commit 和 hash。duplicate 在上下文存在时为 ready，并输出抑制数量；上下文缺失时为 missing。

- [ ] **步骤 4：运行聚焦和全量测试**

```bash
cd "$EXT"
bun test packages/omp-compliance/test/extension.test.ts
OMP_V17_HOST="$HOST" bun test
bun run build
```

预期：全部退出码 0。

- [ ] **步骤 5：提交并推送供宿主锁定**

```bash
cd "$EXT"
git add packages/omp-compliance/src/host/extension-api.ts \
  packages/omp-compliance/src/extension.ts \
  packages/omp-compliance/test/support/fake-extension-api.ts \
  packages/omp-compliance/test/extension.test.ts
git commit -m "功能：诊断合规扩展内置身份"
git push origin work/v17-omp-custom-adapter
git rev-parse HEAD
```

预期：最后一行得到 40 位 commit，且 `git branch -r --contains HEAD` 包含 `origin/work/v17-omp-custom-adapter`。

### 任务 3：添加精确 Submodule 与构建前硬门

**仓库：** `oh-my-pi`

**文件：**
- 创建：`.gitmodules`
- 创建：`vendor/omp-custom` gitlink
- 创建：`scripts/embedded-compliance.ts`
- 创建：`scripts/embedded-compliance.test.ts`

- [ ] **步骤 1：先写失败的验证器测试**

测试必须建立临时父仓库和临时 submodule 仓库，覆盖：

```ts
expect(() => inspectEmbeddedCompliance(missingRoot)).toThrow("OMP_COMPLIANCE_SUBMODULE_MISSING");
expect(clean.identity.gitCommit).toMatch(/^[0-9a-f]{40}$/);
expect(clean.identity.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
expect(() => inspectEmbeddedCompliance(dirtyRoot)).toThrow("OMP_COMPLIANCE_SUBMODULE_DIRTY");
expect(() => inspectEmbeddedCompliance(driftRoot)).toThrow("OMP_COMPLIANCE_GITLINK_MISMATCH");
```

- [ ] **步骤 2：运行测试确认红灯**

```bash
cd "$HOST"
bun test scripts/embedded-compliance.test.ts
```

预期：FAIL，`scripts/embedded-compliance.ts` 不存在。

- [ ] **步骤 3：实现确定性验证器**

公开接口固定为：

```ts
export interface EmbeddedComplianceInspection {
  readonly submodulePath: string;
  readonly identity: {
    readonly packageName: "@bearmaxdd/omp-compliance";
    readonly packageVersion: string;
    readonly gitCommit: string;
    readonly sourceHash: `sha256:${string}`;
    readonly protocol: "advisor-review/v1";
  };
}

export function inspectEmbeddedCompliance(repoRoot: string): EmbeddedComplianceInspection;
```

实现规则：

1. `git -C repoRoot ls-files --stage vendor/omp-custom` 必须返回 mode `160000` 和 gitlink commit。
2. `git -C vendor/omp-custom rev-parse HEAD` 必须等于 gitlink。
3. `git -C vendor/omp-custom status --porcelain` 必须为空。
4. 读取 `packages/omp-compliance/package.json`，name 必须为 `@bearmaxdd/omp-compliance`。
5. 使用 `git ls-files -z packages/omp-compliance/src packages/omp-compliance/package.json` 获取排序后的受控文件。
6. hash 输入为每个仓库相对路径、NUL、文件字节、NUL，最终格式为 `sha256:` 加 64 位小写 hex。
7. 任一失败使用上面测试中的稳定错误码。

- [ ] **步骤 4：添加远端可获取的 submodule**

```bash
cd "$HOST"
EXT_COMMIT="$(git -C "$EXT" rev-parse HEAD)"
git submodule add https://github.com/BearMaxDD/omp-custom.git vendor/omp-custom
git -C vendor/omp-custom fetch origin "$EXT_COMMIT"
git -C vendor/omp-custom checkout --detach "$EXT_COMMIT"
git add .gitmodules vendor/omp-custom
```

运行：

```bash
bun test scripts/embedded-compliance.test.ts
bun scripts/embedded-compliance.ts
```

预期：测试通过，命令输出 package、版本、40 位 commit 和 `sha256:` hash。

- [ ] **步骤 5：提交**

```bash
cd "$HOST"
git add .gitmodules vendor/omp-custom scripts/embedded-compliance.ts scripts/embedded-compliance.test.ts
git commit -m "构建：锁定合规扩展 Submodule"
```

### 任务 4：把合规 Factory 设为每个 Session 的不可关闭内置扩展

**仓库：** `oh-my-pi`

**文件：**
- 创建：`packages/coding-agent/src/extensibility/extensions/builtin.ts`
- 创建：`packages/coding-agent/test/embedded-compliance-builtin.test.ts`
- 修改：`packages/coding-agent/src/extensibility/extensions/types.ts`
- 修改：`packages/coding-agent/src/extensibility/extensions/loader.ts`
- 修改：`packages/coding-agent/src/sdk.ts`

- [ ] **步骤 1：编写失败的内置注册测试**

```ts
import { describe, expect, it } from "bun:test";
import { getBuiltinExtensionDescriptors } from "../src/extensibility/extensions/builtin";

describe("embedded omp compliance", () => {
  it("始终返回不可关闭的合规 factory", () => {
    const descriptors = getBuiltinExtensionDescriptors();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.id).toBe("@bearmaxdd/omp-compliance");
    expect(descriptors[0]?.disableable).toBe(false);
    expect(typeof descriptors[0]?.factory).toBe("function");
  });
});
```

增加一个真实 `createAgentSession` 夹具，传入 `disableExtensionDiscovery: true`，断言 `extensionsResult.extensions` 中存在路径 `<builtin:@bearmaxdd/omp-compliance>`；连续创建主、子两个 Session，断言两个 Extension 对象和 Runtime 不同。

同一测试还要设置 `disabledExtensions: ["extension-module:omp-compliance"]`，证明普通禁用配置无效；传入一个抛错的内置 factory，断言 Session 创建失败关闭而不是降级启动。

- [ ] **步骤 2：运行测试确认红灯**

```bash
cd "$HOST"
bun test packages/coding-agent/test/embedded-compliance-builtin.test.ts
```

预期：FAIL，builtin 模块不存在。

- [ ] **步骤 3：实现内置描述符**

```ts
import complianceFactory from "../../../../../vendor/omp-custom/packages/omp-compliance/src/extension";
import { embeddedComplianceBuildIdentity } from "../../../../../vendor/omp-custom/packages/omp-compliance/src/embedding/build-identity";
import type { ExtensionFactory } from "./types";

export interface BuiltinExtensionDescriptor {
  readonly id: string;
  readonly disableable: false;
  readonly factory: ExtensionFactory;
  readonly identity: ReturnType<typeof embeddedComplianceBuildIdentity>;
}

export function getBuiltinExtensionDescriptors(): readonly BuiltinExtensionDescriptor[] {
  return Object.freeze([Object.freeze({
    id: "@bearmaxdd/omp-compliance",
    disableable: false,
    factory: complianceFactory,
    identity: embeddedComplianceBuildIdentity(),
  })]);
}
```

`loadExtensionFromFactory` 增加可选第六参数 `embeddedExtensionContext`，`ConcreteExtensionAPI` 以只读属性公开它。`sdk.ts` 必须先逐个加载 builtin descriptor，再加载 `options.extensions` 和 custom-tools factory；内置名称固定为 `<builtin:@bearmaxdd/omp-compliance>`。接线只能放在公共 `createAgentSession` 路径，不能分别塞进 Interactive、Print、RPC 或 ACP 模式。

- [ ] **步骤 4：验证不可关闭和隔离**

```bash
cd "$HOST"
bun test packages/coding-agent/test/embedded-compliance-builtin.test.ts
bun test packages/coding-agent/test/sdk-extensions-per-session-binding.test.ts
bun test packages/coding-agent/test/sdk-preloaded-extensions-isolation.test.ts
```

预期：全部通过；`--no-extensions` 夹具仍看到内置合规工具，普通发现扩展数量保持原语义。

- [ ] **步骤 5：提交**

```bash
cd "$HOST"
git add packages/coding-agent/src/extensibility/extensions/builtin.ts \
  packages/coding-agent/src/extensibility/extensions/types.ts \
  packages/coding-agent/src/extensibility/extensions/loader.ts \
  packages/coding-agent/src/sdk.ts \
  packages/coding-agent/test/embedded-compliance-builtin.test.ts
git commit -m "功能：将 Advisor 合规扩展内置到会话"
```

### 任务 5：在执行前抑制旧外部合规插件

**仓库：** `oh-my-pi`

**文件：**
- 创建：`packages/coding-agent/src/extensibility/extensions/embedded-dedup.ts`
- 修改：`packages/coding-agent/src/sdk.ts`
- 修改：`packages/coding-agent/test/extensions-discovery.test.ts`
- 修改：`packages/coding-agent/test/plugin-extensions-discovery.test.ts`

- [ ] **步骤 1：编写失败的去重测试**

创建三个夹具：

1. package name 为 `@bearmaxdd/omp-compliance`，入口顶层设置 `globalThis.__externalComplianceExecuted = true`；
2. 文件名为 `omp-compliance.ts`，但 package name 为 `@demo/not-compliance`；
3. 显式路径位于名为 `omp-compliance` 的目录，但没有 package identity。

断言：

```ts
expect(result.paths).not.toContain(realComplianceEntry);
expect(globalThis.__externalComplianceExecuted).toBeUndefined();
expect(result.suppressedExternalDuplicates).toEqual(["@bearmaxdd/omp-compliance"]);
expect(result.paths).toContain(fakeNameEntry);
expect(() => ambiguousResult).toThrow("OMP_COMPLIANCE_EXTERNAL_IDENTITY_AMBIGUOUS");
```

- [ ] **步骤 2：运行测试确认红灯**

```bash
cd "$HOST"
bun test packages/coding-agent/test/extensions-discovery.test.ts \
  packages/coding-agent/test/plugin-extensions-discovery.test.ts
```

预期：真实旧插件仍被加载，测试失败。

- [ ] **步骤 3：实现 package identity 过滤器**

```ts
export interface EmbeddedDedupResult {
  readonly paths: string[];
  readonly suppressedExternalDuplicates: string[];
}

export async function filterEmbeddedExtensionDuplicates(
  paths: readonly string[],
  builtinIds: ReadonlySet<string>,
): Promise<EmbeddedDedupResult>;
```

实现从入口目录逐级向上查找最近 `package.json`，解析 string `name`；命中 builtin ID 时过滤。仅文件名相似但 package name 不同必须保留。目录或文件名指向合规扩展但无法建立 package identity 时抛稳定错误，禁止执行未知代码。

在 `discoverSessionExtensionPaths` 的禁用发现分支和普通分支之后都调用过滤器。将返回值升级为包含 paths 与 suppressed IDs 的结构；`loadSessionExtensions`、正常创建、preloaded paths 和 subagent 转发都保留该诊断。

首次抑制时使用宿主 logger 输出一次迁移提示；测试还必须确认旧插件目录和 `package.json` 仍然存在，宿主不得自动删除用户文件。

- [ ] **步骤 4：把抑制结果传给内置 Factory**

调用 `loadExtensionFromFactory` 时传入：

```ts
{
  identity: descriptor.identity,
  suppressedExternalDuplicates: extensionsResult.suppressedExternalDuplicates,
}
```

外部扩展不得收到该上下文。

- [ ] **步骤 5：运行发现、插件和 Session 回归**

```bash
cd "$HOST"
bun test packages/coding-agent/test/extensions-discovery.test.ts
bun test packages/coding-agent/test/plugin-extensions-discovery.test.ts
bun test packages/coding-agent/test/embedded-compliance-builtin.test.ts
```

预期：全部通过，外部夹具顶层副作用未发生。

- [ ] **步骤 6：提交**

```bash
cd "$HOST"
git add packages/coding-agent/src/extensibility/extensions/embedded-dedup.ts \
  packages/coding-agent/src/sdk.ts \
  packages/coding-agent/test/extensions-discovery.test.ts \
  packages/coding-agent/test/plugin-extensions-discovery.test.ts
git commit -m "修复：阻止重复加载外部合规扩展"
```

### 任务 6：把 Submodule 身份注入所有二进制构建

**仓库：** `oh-my-pi`

**文件：**
- 修改：`packages/coding-agent/scripts/compile-binary.ts`
- 修改：`packages/coding-agent/scripts/build-binary.ts`
- 修改：`scripts/ci-release-build-binaries.ts`
- 修改：`scripts/ci-release-build-binaries.test.ts`

- [ ] **步骤 1：编写失败的 compile define 测试**

对 `compileCodingAgent` 的构建参数夹具断言：

```ts
expect(defines.__OMP_COMPLIANCE_PACKAGE_VERSION__).toBe(JSON.stringify("0.1.0"));
expect(defines.__OMP_COMPLIANCE_GIT_COMMIT__).toMatch(/^"[0-9a-f]{40}"$/);
expect(defines.__OMP_COMPLIANCE_SOURCE_HASH__).toMatch(/^"sha256:[0-9a-f]{64}"$/);
```

dry-run 在 submodule 缺失、脏状态和 gitlink 不一致时必须返回对应稳定错误。

- [ ] **步骤 2：运行测试确认红灯**

```bash
cd "$HOST"
bun test scripts/ci-release-build-binaries.test.ts
```

预期：FAIL，compile options 尚无合规身份。

- [ ] **步骤 3：集中生成 compile defines**

给 `CodingAgentCompileOptions` 增加必需属性 `embeddedCompliance`，并在 Bun `define` 中加入：

```ts
"__OMP_COMPLIANCE_PACKAGE_VERSION__": JSON.stringify(identity.packageVersion),
"__OMP_COMPLIANCE_GIT_COMMIT__": JSON.stringify(identity.gitCommit),
"__OMP_COMPLIANCE_SOURCE_HASH__": JSON.stringify(identity.sourceHash),
```

`build-binary.ts` 与 `ci-release-build-binaries.ts` 在任何生成动作前调用 `inspectEmbeddedCompliance(repoRoot)`，把同一个结果传给所有 target。禁止每个 target 重新读取不同状态。

- [ ] **步骤 4：验证 dry-run 与聚焦构建测试**

```bash
cd "$HOST"
bun test scripts/embedded-compliance.test.ts scripts/ci-release-build-binaries.test.ts
RELEASE_TARGETS=darwin-arm64,linux-x64 bun run ci:release:build-binaries --dry-run
```

预期：测试通过，dry-run 显示两个 target 且只显示一个经过验证的 compliance commit/hash。

- [ ] **步骤 5：提交**

```bash
cd "$HOST"
git add packages/coding-agent/scripts/compile-binary.ts \
  packages/coding-agent/scripts/build-binary.ts \
  scripts/ci-release-build-binaries.ts \
  scripts/ci-release-build-binaries.test.ts
git commit -m "构建：把合规身份注入单二进制"
```

### 任务 7：接入 CI、文档与跨仓门禁

**仓库：** `oh-my-pi` 和 `omp-custom`

**文件：**
- 修改：`oh-my-pi/.github/workflows/ci.yml`
- 修改：`oh-my-pi/README.md`
- 创建：`oh-my-pi/docs/omp-custom-embedding.md`
- 修改：`omp-custom/README.md`
- 修改：`omp-custom/docs/install-local.md`
- 修改：`omp-custom/docs/upstream-upgrade-runbook.md`
- 修改：`omp-custom/scripts/test-v17-integration.sh`
- 修改：`omp-custom/packages/omp-compliance/test/docs/workflow-docs.test.ts`

- [ ] **步骤 1：编写 CI/文档扫描测试**

在 `omp-custom` 新增测试断言：

- 当前安装说明不再要求单二进制用户执行 `omp install`；
- `oh-my-pi/.github/workflows/ci.yml` 中每个 `actions/checkout` 块都包含 `submodules: recursive`；
- runbook 包含 `git submodule update --init --recursive`；
- 当前入口不存在 v16 构建或下载说明。

- [ ] **步骤 2：运行扫描确认红灯**

```bash
cd "$EXT"
OMP_V17_HOST="$HOST" bun test packages/omp-compliance/test/docs
```

预期：FAIL，CI checkout 尚未递归初始化，安装文档仍描述外部扩展。

- [ ] **步骤 3：修改 CI 与文档**

所有 checkout 保留当前 action 版本，只增加 `with.submodules`。未固定 SHA 的现有块使用：

```yaml
- uses: actions/checkout@v4
  with:
    submodules: recursive
```

已经固定 SHA 的 release 块继续使用仓库当前的 `actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10`，并增加相同的 `with`。

文档明确区分：

- 最终用户：只复制平台二进制；
- 宿主开发者：clone 后初始化 submodule；
- 扩展开发者：在 `omp-custom` 完成测试、推送 commit，再更新宿主 gitlink；
- 旧外部安装：可卸载，但宿主会在执行前自动抑制。

- [ ] **步骤 4：扩展跨仓脚本**

`scripts/test-v17-integration.sh` 在原有契约和 remediate→pass 测试前增加：

```bash
if git -C "$OMP_V17_HOST" submodule status --recursive | rg -q '^[-+U]'; then
  echo "submodule 未初始化、漂移或冲突" >&2
  exit 1
fi
bun "$OMP_V17_HOST/scripts/embedded-compliance.ts"
```

并运行内置、去重与 build define 聚焦测试。

- [ ] **步骤 5：验证并分别提交**

```bash
cd "$EXT"
OMP_V17_HOST="$HOST" bash scripts/test-v17-integration.sh
bun test packages/omp-compliance/test/docs
git add README.md docs/install-local.md docs/upstream-upgrade-runbook.md \\
  scripts/test-v17-integration.sh packages/omp-compliance/test/docs
git commit -m "文档：切换为 Advisor 合规单二进制交付"
git push origin work/v17-omp-custom-adapter

cd "$HOST"
git -C vendor/omp-custom fetch origin work/v17-omp-custom-adapter
git -C vendor/omp-custom checkout --detach "$(git -C "$EXT" rev-parse HEAD)"
git add vendor/omp-custom .github/workflows/ci.yml README.md docs/omp-custom-embedding.md
git commit -m "构建：更新内置合规扩展版本"
```

预期：两个仓库工作区干净，宿主 gitlink 等于扩展 HEAD。

### 任务 8：构建单二进制并完成最终验收

**仓库：** `oh-my-pi`，同时使用 `omp-custom` 门禁

**文件：**
- 创建：`scripts/accept-embedded-compliance-macos.sh`
- 创建：`scripts/verify-embedded-compliance-linux.ts`
- 修改：`scripts/ci-release-build-binaries.test.ts`
- 产物：`packages/coding-agent/binaries/omp-darwin-arm64`
- 产物：`packages/coding-agent/binaries/omp-linux-x64`

- [ ] **步骤 1：先写成品验收脚本测试**

macOS 脚本必须拒绝：

- HOME 中预装 `@bearmaxdd/omp-compliance`；
- Doctor 缺少 embedding/source/duplicate；
- `--no-extensions` 下缺少 `compliance_complete`；
- remediate→pass fixture 失败。

Linux 验证脚本必须检查：

```ts
assert(fileOutput.includes("ELF 64-bit LSB executable, x86-64"));
assert(strings.includes("@bearmaxdd/omp-compliance"));
assert(strings.includes("compliance_complete"));
assert(strings.includes("brainstorm_topic_ready"));
assert(strings.includes(expectedIdentity.gitCommit));
assert(strings.includes(expectedIdentity.sourceHash));
```

- [ ] **步骤 2：运行脚本测试确认红灯**

```bash
cd "$HOST"
bun test scripts/ci-release-build-binaries.test.ts
```

预期：FAIL，两个验收脚本尚不存在。

- [ ] **步骤 3：实现 macOS 新鲜 HOME 真实验收**

`accept-embedded-compliance-macos.sh` 必须：

1. 使用 `mktemp -d` 创建 HOME、XDG_DATA_HOME 和临时 Git 项目；
2. 确认 `plugin list --json` 中没有外部合规插件；
3. 运行 `--version`、`--help`、`--smoke-test`；
4. 使用 `--no-extensions -p "/compliance doctor"`，匹配 embedding/source/duplicate 以及原有六项 ready；
5. 运行 `omp-custom` 的真实 v17 remediate→pass fixture；
6. 临时安装旧插件夹具后再次启动，确认提示已抑制且 Doctor 仍为 ready；
7. 清空代理环境变量并重复 `--smoke-test`，完成离线启动证明；
8. 运行现有人工越权审计夹具，确认内置化没有改变原因和 Evidence 合同。

- [ ] **步骤 4：构建两个目标**

```bash
cd "$HOST"
RELEASE_TARGETS=darwin-arm64,linux-x64 bun run ci:release:build-binaries
```

预期：生成 Mach-O arm64 与 ELF x86-64，日志没有 native sentinel mismatch。

- [ ] **步骤 5：运行 macOS 真实验收与 Linux 构建验收**

```bash
cd "$HOST"
bash scripts/accept-embedded-compliance-macos.sh \
  packages/coding-agent/binaries/omp-darwin-arm64 \
  "$EXT"
bun scripts/verify-embedded-compliance-linux.ts \
  packages/coding-agent/binaries/omp-linux-x64
shasum -a 256 \
  packages/coding-agent/binaries/omp-darwin-arm64 \
  packages/coding-agent/binaries/omp-linux-x64
```

预期：macOS 真实闭环通过；Linux 只执行规格第 9.3 节定义的构建验收。

- [ ] **步骤 6：运行全量门禁**

```bash
cd "$EXT"
OMP_V17_HOST="$HOST" bun test
bun run build
./packages/omp-compliance/node_modules/.bin/biome check packages/omp-compliance/src packages/omp-compliance/test

cd "$HOST"
bun test scripts/embedded-compliance.test.ts scripts/ci-release-build-binaries.test.ts
bun test packages/coding-agent/test/embedded-compliance-builtin.test.ts
bun test packages/coding-agent/test/extensions-discovery.test.ts
bun test packages/coding-agent/test/plugin-extensions-discovery.test.ts
bun --cwd=packages/coding-agent run check:types
git diff --check
```

预期：全部退出码 0，两个工作区除未跟踪的 release 二进制外无源码改动。

- [ ] **步骤 7：提交验收脚本，不提交二进制**

```bash
cd "$HOST"
git add scripts/accept-embedded-compliance-macos.sh \
  scripts/verify-embedded-compliance-linux.ts \
  scripts/ci-release-build-binaries.test.ts
git commit -m "测试：验收 Advisor 合规单二进制"
git status --short
```

预期：`packages/coding-agent/binaries` 产物保持忽略，不进入 commit。

## 最终完成证据

执行者最终必须报告：

- `omp-custom` HEAD、`oh-my-pi` HEAD 和宿主 gitlink commit；
- submodule 源码 hash；
- macOS ARM64 与 Linux x64 二进制绝对路径、大小和 SHA-256；
- macOS Doctor 全部检查；
- macOS remediate→pass 结果；
- Linux ELF/架构/解释器与嵌入字符串检查；
- 两仓测试、类型和格式检查总数；
- 外部旧插件未执行的测试证据；
- 二进制未提交到 Git 的 `git status` 证据。
