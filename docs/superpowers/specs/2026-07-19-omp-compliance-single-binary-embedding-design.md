# OMP Compliance 单二进制内置设计

**日期：** 2026-07-19  
**状态：** 已确认设计，待实现计划  
**涉及仓库：** `BearMaxDD/omp-custom`、`BearMaxDD/oh-my-pi`  
**目标基线：** Oh My Pi v17.0.1+

## 1. 背景

当前 `oh-my-pi` 二进制已经包含 Advisor Review Protocol v1、Advisor 生命周期事件、`advisor_before_run`、XD 和 Extension API，但 Completion Gate、TDD 监管、Evidence、Brainstorm 评审、Codebase 监管及子代理委派监管仍由外部 `@bearmaxdd/omp-compliance` 扩展提供。

现有发布方式要求用户同时复制 `omp` 二进制并安装扩展。该方式不满足“一个文件即可迁移和运行”的目标，也容易在新机器上出现扩展漏装、版本漂移或重复安装。

## 2. 设计决策

采用 **Git Submodule 精确锁定 + 编译期静态导入**：

1. `omp-custom` 保持独立仓库和合规功能唯一源码。
2. `oh-my-pi` 在 `vendor/omp-custom` 以 Git Submodule 锁定一个已验收 commit。
3. 宿主通过一个很薄的内置扩展注册模块静态导入 `packages/omp-compliance/src/extension.ts`。
4. Bun release 编译器沿静态依赖图把扩展及其内部模块合并进最终可执行文件。
5. 运行时不释放 Bundle、不访问网络、不扫描额外文件，也不要求用户执行 `omp install`。

该设计保留“Fork 只维护协议和接线补丁”的边界：合规业务逻辑仍只在 `omp-custom` 演进，宿主仅保存 submodule 指针、内置注册表、去重逻辑及发布验收。

## 3. 目标与非目标

### 3.1 目标

- macOS ARM64 与 Linux x64 最终用户只复制一个 `omp` 文件。
- 新鲜 HOME、空插件目录、无网络时自动启用完整 Advisor 合规能力。
- `--no-extensions`、`disabledExtensions` 和扩展面板不能关闭内置合规扩展。
- 主代理、子代理、交互模式、Print、RPC 和 ACP 使用同一内置 ExtensionFactory。
- 外部安装的旧 `omp-compliance` 不得造成工具、命令或事件处理器重复注册。
- 二进制能够证明内置扩展 commit、版本和源码摘要，便于审计。
- 官方上游升级时只需重新适配宿主接线，不把业务实现搬回 Fork。

### 3.2 非目标

- 不把所有第三方扩展改成内置扩展。
- 不恢复 v16 Adapter、严格路由、PlanRun 或批量角色模型分配。
- 不在运行时自解压 JavaScript Bundle。
- 不允许通过普通设置静默关闭 Completion Gate。
- 不改变现有人工越权语义；越权仍必须显式提供原因并永久写入 Evidence。

## 4. 仓库与依赖边界

### 4.1 `omp-custom`

`packages/omp-compliance/src/extension.ts` 是唯一生产入口，必须继续导出默认 `ExtensionFactory`。包内不得依赖调用者机器的绝对路径。

当前 `packages/omp-compliance/package.json` 中指向本机 worktree 的绝对 `devDependency` 必须移除或改为可移植开发配置。Submodule 构建本身不得要求在 `vendor/omp-custom` 内执行第二次 `bun install`。

`omp-custom` 为每个可嵌入版本生成以下构建身份：

```ts
interface EmbeddedComplianceBuildIdentity {
  packageName: "@bearmaxdd/omp-compliance";
  packageVersion: string;
  gitCommit: string;
  sourceHash: "sha256:<digest>";
  protocol: "advisor-review/v1";
}
```

身份文件由确定性脚本生成并参与静态编译，不包含时间戳、工作区绝对路径或凭据。

### 4.2 `oh-my-pi`

Submodule 固定路径为：

```text
vendor/omp-custom
```

宿主新增单一内置注册模块，职责仅包括：

- 静态导入 `omp-compliance` 默认 ExtensionFactory；
- 暴露稳定内置 ID `@bearmaxdd/omp-compliance`；
- 暴露嵌入构建身份；
- 将 factory 注入每个新建 Agent Session。

宿主不得复制 `omp-custom` 的状态机、规则包、Evidence 或 TDD 实现。

## 5. 加载模型

### 5.1 启动顺序

每个 Session 的扩展顺序固定为：

1. 不可关闭的宿主内置扩展；
2. SDK 调用者显式传入的 inline extensions；
3. 从用户和项目配置发现的普通扩展；
4. 由自定义工具生成的桥接扩展。

`omp-compliance` 必须在首个 `session_start` 之前注册完成，确保第一次用户输入、第一次工具调用和第一次 Advisor 请求都受监管。

### 5.2 不可关闭边界

以下入口只影响普通扩展，不影响内置合规扩展：

- `--no-extensions`
- `disabledExtensions`
- `/extensions` 面板启停操作
- 用户级或项目级插件卸载

内置扩展缺失、激活抛错、协议不兼容或身份校验失败时，宿主必须失败关闭并给出稳定诊断，不允许降级为无监管运行。

### 5.3 主代理与子代理

内置 factory 在 `createAgentSession()` 的公共创建链注册，不能只接入交互 CLI。子代理必须创建自己的扩展实例和会话级状态，不能复用主代理的可变 Runtime、Evidence Store 或事件处理器。

## 6. 外部旧插件去重

已经通过 `omp install` 安装的旧 `@bearmaxdd/omp-compliance` 必须在执行模块代码之前被识别并跳过。

识别优先级：

1. 插件清单中的 package name；
2. 从扩展入口向上查找最近的 `package.json` 并读取 `name`；
3. 规范化后的已安装插件根身份。

禁止使用文件名包含关系作为唯一判断依据。若发现旧外部插件：

- 不加载其 JavaScript；
- 不重复注册工具、命令和生命周期事件；
- 输出一次迁移提示，说明功能已内置并建议卸载旧插件；
- 不自动删除用户文件；
- 将去重结果暴露给 `/compliance doctor`。

直接传入未知来源且无法确认 package identity 的同名扩展应失败关闭，不能冒险双重激活。

## 7. 构建与发布

### 7.1 前置检查

release 构建在编译前必须验证：

- submodule 已初始化且 HEAD 与父仓库记录的 gitlink 一致；
- submodule 工作区干净；
- ExtensionFactory 入口和构建身份存在；
- 声明的 Protocol 为 `advisor-review/v1`；
- 重新计算的源码 hash 与构建身份一致；
- 源码扫描不存在 v16 可执行入口。

任一检查失败均终止构建。

### 7.2 静态编译

宿主使用普通 ESM 静态导入引用 submodule 源码。禁止使用：

- 运行时绝对路径；
- `import()` 加载外部文件；
- 临时目录解包；
- 内置 HTTP 下载；
- 依赖用户 HOME 的插件发现。

Bun `--compile` 生成的二进制必须包含 `compliance_complete`、`brainstorm_topic_ready` 和内置扩展身份字符串。

### 7.3 Submodule 更新

升级流程固定为：

1. 在 `omp-custom` 完成功能、测试和提交；
2. 记录该 commit 的全量门禁 Evidence；
3. 在 `oh-my-pi/vendor/omp-custom` 更新 gitlink；
4. 运行跨仓契约测试、macOS 真实验收和 Linux 构建验收；
5. 使用中文提交说明更新指针；
6. 禁止引用未推送、脏工作区或浮动分支。

## 8. Doctor 与可观测性

`/compliance doctor` 新增内置信息：

```text
Doctor embedding: ready — @bearmaxdd/omp-compliance 0.1.0
Doctor source: ready — <commit> / sha256:<digest>
Doctor duplicate: ready — no external duplicate loaded
```

原有 Protocol、Advisor、XD、Codebase、项目绑定和存储检查保持不变。Doctor 只能报告真实运行状态，不能仅凭二进制中存在字符串判定 ready。

`omp --version` 保持官方版本语义；可新增机器可读诊断命令输出内置扩展身份，但不把扩展版本拼进官方 SemVer。

## 9. 测试设计

### 9.1 单元与契约测试

- 内置注册表始终返回合规 factory。
- `--no-extensions` 下仍注册 `compliance_complete`。
- 普通第三方扩展仍可被关闭。
- 主代理和子代理获得不同扩展实例。
- 缺失或错误 submodule 身份时构建前检查失败。
- 外部旧插件在模块执行前被跳过。
- 伪造文件名但 package identity 不匹配时不得误去重。
- 内置激活失败时 Session 创建失败关闭。

### 9.2 macOS ARM64 成品真实验收

macOS ARM64 必须在新鲜临时 HOME 中执行：

1. 确认不存在用户级和项目级扩展；
2. 运行 `--version`、`--help` 和 `--smoke-test`；
3. 启动真实 Session；
4. 验证 `compliance_complete` 与 Brainstorm 工具已注册；
5. 运行 `/compliance doctor`，所有必要检查为 ready；
6. 执行 TDD 绑定、Codebase Pack、子代理委派、首次 remediate、修复、第二次 pass；
7. 验证 Evidence schema、项目 UUID、git head、diff hash 和 verdict 上下文；
8. 安装一个旧外部扩展夹具，确认只加载内置版本；
9. 断开网络后重复关键启动检查。

只验证 `file`、字符串、`--version` 或编译成功，不能替代上述 macOS 真实闭环。

### 9.3 Linux x64 构建验收

Linux x64 不要求运行真实 Session 或完整 Advisor 闭环，只要求：

- 交叉编译成功并生成 ELF x86-64 可执行文件；
- 记录文件大小、SHA-256、ELF 架构、解释器和最低内核信息；
- 静态确认二进制包含内置扩展 ID、构建身份、`compliance_complete` 和 `brainstorm_topic_ready`；
- 构建日志不存在 native sentinel mismatch、未解析模块或外部扩展路径；
- Linux 产物与 macOS 产物嵌入相同的 submodule commit 和源码 hash。

Linux 真实运行可以作为发布后的增强验证，但不作为本设计的完成门。

## 10. 验收标准

只有同时满足以下条件才可声明单二进制完成：

- macOS ARM64 与 Linux x64 均生成目标格式产物并记录 SHA-256；
- macOS 新鲜 HOME 无需安装扩展即可通过真实 Doctor；
- 完整 remediate 到 pass 闭环在 macOS ARM64 通过；
- Linux x64 通过第 9.3 节定义的构建验收；
- `--no-extensions` 不能绕过合规层；
- 旧外部插件不会重复执行；
- 二进制离线启动；
- submodule commit、源码 hash 和运行身份一致；
- `omp-custom` 与 `oh-my-pi` 全量测试、类型检查和格式检查通过；
- 二进制不提交到 Git，发布产物由既有 release 目录和 CI artifact 管理。

## 11. 风险与控制

| 风险 | 控制 |
|---|---|
| clone 后未初始化 submodule | 构建前硬失败，并在开发和 CI 文档统一使用递归 checkout |
| 上游更新覆盖接线 | 将接线集中在一个注册模块和少量 SDK 调用点，并保留跨仓契约测试 |
| 旧插件重复加载 | 在执行模块前按 package identity 去重 |
| 主代理和子代理共享状态 | 每个 Session 独立调用 factory |
| submodule 指向未发布提交 | CI 校验 gitlink、远端可达性和工作区干净状态 |
| 单文件体积增加 | 记录基线和增量，但不以牺牲合规能力换取体积 |
| 用户无法关闭扩展 | 只允许现有可审计人工越权，不提供静默禁用开关 |

## 12. 后续演进

未来若 `@bearmaxdd/omp-compliance` 发布到公共包仓库，可将源码供应从 submodule 切换为精确版本依赖。只允许替换构建供应层，不得改变内置 ID、加载顺序、不可关闭语义、Evidence 或验收合同。
