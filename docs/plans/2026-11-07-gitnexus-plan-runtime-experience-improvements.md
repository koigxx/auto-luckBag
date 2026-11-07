# 六项运行体验优化实施计划
> 深度：深入。基线 13e7eb057055ee2ab544ed90048720157093b449。
> gitnexus 1.6.12 analyze --index-only --pdg 已完成，runner identity schema 4/current。
> Evidence provenance schema 2；完整摘要和路径清单见 §11。

## 1. 目标
完成运行状态说明、登录诊断、设置差异、运行回顾、异常日志联动、后台窗口说明六项。用户无需阅读日志即可理解等待，异常时有下一步操作。

## 2. 当前行为
[verified] AutoRunner.getState（auto-runner.ts:85）只有文字等待原因，runtime.perform（runtime.ts:78）持有导航真实readyAt。AuthService.verifySavedSession/checkLogin有代次及稳定身份保护，AuthStatus缺少阶段。SettingsView有baseline/draft但无差异清单。runReports以runId归属，有活跃时间与skipReasons，无细分耗时。ActivityLog只搜索当前打开后的最近500条。application关闭窗口即隐藏，退出停止并清理。

## 3. 架构
主进程采集事实→shared类型/纯函数→IPC/preload/useIpc→Vue。展示不得驱动调度、预算或认证。可选字段兼容旧记录；缺失数据不回填推断。

## 4. GitNexus发现
[graph] context(getState)定位application、IPC和publish/start/stop；报告48处接收器类型缺口，源码核对UI及测试。
[graph] impact(AuthStatus,upstream,depth3) d1为auth-service、RunDashboard、useIpc、types/api，全部纳入验证。
[graph] impact(runReports,upstream,depth3) d1为setupIpcHandlers；源码补核Insights→RecordsView/ReviewSummary。
[graph] query(decision startRun endRun)定位RuntimeRepository.decision；[verified]其已按活动run累计skipReasons，无需推断旧决策归属。
clusters/processes已读取，主要边界Main/Components/Composables；图的Vue跨语言和接收器缺口不代表无依赖。

## 5. 控制流与PDG
[graph+verified] verifySavedSession的signal/generation控制异步早退；诊断回调必须同样隔离。PDG有界查询截断，未读部分以源码为准。
[verified] probeSession先安装自然响应监听再导航，finally清理计时器/监听。诊断不改变认证结果和expired优先级。
[verified] runtime.perform随机间隔只采样一次，await后重新assertActive。观察使用同一readyAt，不重采样或提前执行。

## 6. 改动方案
A 运行说明：ExecutionGate登记只读等待状态，runtime.perform清理；AutoRunner推送活动、原因、下一步、更新时间、可空预计时间。覆盖导航、额度、预约、扫描、重试、休息、收尾和停止。
B 登录诊断：shared/auth定义有限阶段与结果；AuthService/probe报告浏览器、页面、登录证据、身份检查；auth:update通过预加载传递。可展开详情、重试和人工登录。仅输出布尔/枚举，不含Cookie/身份/页面原文。
C 设置差异：基于baseline/draft覆盖类型、预算、策略和开关，单位枚举可读，保存成功及还原清空，保存失败保留；不增加确认弹窗。本次后台/时长与保存策略区分。
D 运行回顾：新run可选采样耗时分类（任务、探索、等待、休息、检查），拒绝倒退和超过90秒挂起，不改变预算时长。显示主要跳过原因、未知与未决；旧数据标未采集。
E 日志联动：log:add附真实runId/roomUrl/lotteryId（可得时）；记录/异常/报告可跳转带上下文的日志，支持清除过滤。缺关联不误匹配。复制诊断摘要使用允许列表计数，不输出任意日志、URL、口令、凭据或账号标识；复制失败反馈。
F 窗口行为：后台选项附近说明隐藏任务浏览器、关主窗口继续、退出停止、电脑需唤醒。托盘与页面共享状态标签，收尾请求不重复。

## 7. 顺序
1 共享模型与纯函数；2 主进程只读采集和持久化可选统计；3 IPC传递与账号切换清理；4 Vue六项入口和呈现；5 测试、截图和用户文档。每步不修改原业务规则。

## 8. 测试
新增tests/experience.test.ts覆盖时间边界、差异、过滤、脱敏；更新auth.test.ts/auth-probe.test.ts覆盖阶段与取消；runner.test.ts/product.test.ts覆盖状态、报告、旧记录与重启；ui-smoke覆盖所有入口、复制失败、窄窗/中英文。运行typecheck、npm test、test:smoke。

## 9. 风险
展示污染调度、诊断异步回写、统计与预算混用最需防范：独立观察字段、代次保护、可选采样字段与允许列表。所有§4直接依赖均通过源码/编译/回归核对。持久化仅添加报告字段，不改预算和动作账本。

## 10. 文件
§11清单加shared观测/展示模块、renderer/types、App与RunDashboard、样式及README/交付文档；无新依赖、无策略默认值变化。

## 11. 实施上下文
```json
{
  "implementation_context": {
    "task_summary": "六项运行体验优化",
    "evidence_provenance": {
      "schema_version": 2,
      "head_commit": "13e7eb057055ee2ab544ed90048720157093b449",
      "generated_plan_path": "docs/plans/2026-11-07-gitnexus-plan-runtime-experience-improvements.md",
      "global_dirty_digest": {
        "algorithm": "sha256",
        "canonicalization": "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records",
        "value": "0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd"
      },
      "cited_path_manifest": [
        {
          "path": "package.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:14327bacf23c77ef43d373844156aba58669b63228e263776229246387f8af29",
          "index_digest": "sha256:14327bacf23c77ef43d373844156aba58669b63228e263776229246387f8af29",
          "worktree_digest": "sha256:14327bacf23c77ef43d373844156aba58669b63228e263776229246387f8af29",
          "untracked_digest": "absent"
        },
        {
          "path": "scripts/ui-smoke.cjs",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:bb5c2399bb8491790167d2bb9ce35586aa7cf4d8467d0b0cda74198de133e6d9",
          "index_digest": "sha256:bb5c2399bb8491790167d2bb9ce35586aa7cf4d8467d0b0cda74198de133e6d9",
          "worktree_digest": "sha256:bb5c2399bb8491790167d2bb9ce35586aa7cf4d8467d0b0cda74198de133e6d9",
          "untracked_digest": "absent"
        },
        {
          "path": "src/main/application.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:2695f0acc09aac0399c1521746c041c7d5b528ecddf0d5260a001a70ee20c5d3",
          "index_digest": "sha256:2695f0acc09aac0399c1521746c041c7d5b528ecddf0d5260a001a70ee20c5d3",
          "worktree_digest": "sha256:2695f0acc09aac0399c1521746c041c7d5b528ecddf0d5260a001a70ee20c5d3",
          "untracked_digest": "absent"
        },
        {
          "path": "src/main/auth-probe.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:3881051a196ecc784282759824faa8b1dd4973b77a4f78d8204245acf5017c21",
          "index_digest": "sha256:3881051a196ecc784282759824faa8b1dd4973b77a4f78d8204245acf5017c21",
          "worktree_digest": "sha256:3881051a196ecc784282759824faa8b1dd4973b77a4f78d8204245acf5017c21",
          "untracked_digest": "absent"
        },
        {
          "path": "src/main/auth-service.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:a4283bd1b4717c97635e85366caeda7491408fa2f0d9d3679cf28e016c280da5",
          "index_digest": "sha256:a4283bd1b4717c97635e85366caeda7491408fa2f0d9d3679cf28e016c280da5",
          "worktree_digest": "sha256:a4283bd1b4717c97635e85366caeda7491408fa2f0d9d3679cf28e016c280da5",
          "untracked_digest": "absent"
        },
        {
          "path": "src/main/auto-runner.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e3fbc52051606b1360b736282b3d84c45747334d3aa444f07ba4fe0deb964704",
          "index_digest": "sha256:e3fbc52051606b1360b736282b3d84c45747334d3aa444f07ba4fe0deb964704",
          "worktree_digest": "sha256:e3fbc52051606b1360b736282b3d84c45747334d3aa444f07ba4fe0deb964704",
          "untracked_digest": "absent"
        },
        {
          "path": "src/main/execution-gate.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:7450bc35ac5f71b21d4099bc25dd4909ab3022258b5823d87fb45f265c98e03f",
          "index_digest": "sha256:7450bc35ac5f71b21d4099bc25dd4909ab3022258b5823d87fb45f265c98e03f",
          "worktree_digest": "sha256:7450bc35ac5f71b21d4099bc25dd4909ab3022258b5823d87fb45f265c98e03f",
          "untracked_digest": "absent"
        },
        {
          "path": "src/main/ipc-handlers.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b8db8ed954447d96782e875e5f2db9ed5fe73e3e398713db3447407530b9caa6",
          "index_digest": "sha256:b8db8ed954447d96782e875e5f2db9ed5fe73e3e398713db3447407530b9caa6",
          "worktree_digest": "sha256:b8db8ed954447d96782e875e5f2db9ed5fe73e3e398713db3447407530b9caa6",
          "untracked_digest": "absent"
        },
        {
          "path": "src/main/runtime-repository.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:2338a0359d577e58f012ebab658890e03d4f489c6585f38362eba4078e6a9252",
          "index_digest": "sha256:2338a0359d577e58f012ebab658890e03d4f489c6585f38362eba4078e6a9252",
          "worktree_digest": "sha256:2338a0359d577e58f012ebab658890e03d4f489c6585f38362eba4078e6a9252",
          "untracked_digest": "absent"
        },
        {
          "path": "src/main/runtime.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:40e0b75bb07bccc876857b6a5154483ec3eca1543a78e693fc35734f87576f61",
          "index_digest": "sha256:40e0b75bb07bccc876857b6a5154483ec3eca1543a78e693fc35734f87576f61",
          "worktree_digest": "sha256:40e0b75bb07bccc876857b6a5154483ec3eca1543a78e693fc35734f87576f61",
          "untracked_digest": "absent"
        },
        {
          "path": "src/preload/index.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:def7d3e471f3c2ae6bb421310957ba4dae8173fd3b73865d38f4aa08a717c5e5",
          "index_digest": "sha256:def7d3e471f3c2ae6bb421310957ba4dae8173fd3b73865d38f4aa08a717c5e5",
          "worktree_digest": "sha256:def7d3e471f3c2ae6bb421310957ba4dae8173fd3b73865d38f4aa08a717c5e5",
          "untracked_digest": "absent"
        },
        {
          "path": "src/renderer/src/components/ActivityLog.vue",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:26675b87f57127458a2a0bb205c15e4f391a187889912f791d3d60516d9301f7",
          "index_digest": "sha256:26675b87f57127458a2a0bb205c15e4f391a187889912f791d3d60516d9301f7",
          "worktree_digest": "sha256:26675b87f57127458a2a0bb205c15e4f391a187889912f791d3d60516d9301f7",
          "untracked_digest": "absent"
        },
        {
          "path": "src/renderer/src/components/RecordsView.vue",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:8e5e4a49e6529c7dad7dd5d289792f5137621d7192eaa84cb197bdee9d3c8bd8",
          "index_digest": "sha256:8e5e4a49e6529c7dad7dd5d289792f5137621d7192eaa84cb197bdee9d3c8bd8",
          "worktree_digest": "sha256:8e5e4a49e6529c7dad7dd5d289792f5137621d7192eaa84cb197bdee9d3c8bd8",
          "untracked_digest": "absent"
        },
        {
          "path": "src/renderer/src/components/ReviewSummary.vue",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:10cb96fc7796a2940573827b9eda8bee73a9072031c376353d8e98309dc628a0",
          "index_digest": "sha256:10cb96fc7796a2940573827b9eda8bee73a9072031c376353d8e98309dc628a0",
          "worktree_digest": "sha256:10cb96fc7796a2940573827b9eda8bee73a9072031c376353d8e98309dc628a0",
          "untracked_digest": "absent"
        },
        {
          "path": "src/renderer/src/components/SettingsView.vue",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:a811ec286997573911c367d3fd3bd9f76012bdf09b69ace4ec2df4fdebf294a1",
          "index_digest": "sha256:a811ec286997573911c367d3fd3bd9f76012bdf09b69ace4ec2df4fdebf294a1",
          "worktree_digest": "sha256:a811ec286997573911c367d3fd3bd9f76012bdf09b69ace4ec2df4fdebf294a1",
          "untracked_digest": "absent"
        },
        {
          "path": "src/renderer/src/composables/useIpc.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b587b1980efd46faafdeaef9f08f8c20cd5894fc9c1359de88ae2415d560c442",
          "index_digest": "sha256:b587b1980efd46faafdeaef9f08f8c20cd5894fc9c1359de88ae2415d560c442",
          "worktree_digest": "sha256:b587b1980efd46faafdeaef9f08f8c20cd5894fc9c1359de88ae2415d560c442",
          "untracked_digest": "absent"
        },
        {
          "path": "src/shared/policy.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:148b474341762f130caa0a9a23d352fb4b76a01ab1ae448f6c2873c8cc7304f3",
          "index_digest": "sha256:148b474341762f130caa0a9a23d352fb4b76a01ab1ae448f6c2873c8cc7304f3",
          "worktree_digest": "sha256:148b474341762f130caa0a9a23d352fb4b76a01ab1ae448f6c2873c8cc7304f3",
          "untracked_digest": "absent"
        },
        {
          "path": "src/shared/review.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:1748173dc7ca9b332d4cdd80d9418f4aff752bf623c58c2779a2261cb4e9abd4",
          "index_digest": "sha256:1748173dc7ca9b332d4cdd80d9418f4aff752bf623c58c2779a2261cb4e9abd4",
          "worktree_digest": "sha256:1748173dc7ca9b332d4cdd80d9418f4aff752bf623c58c2779a2261cb4e9abd4",
          "untracked_digest": "absent"
        },
        {
          "path": "tests/auth-probe.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:26cb8cda349d9d67f65cd9179323947596724c1dd2cda4fa515503a88c9c4551",
          "index_digest": "sha256:26cb8cda349d9d67f65cd9179323947596724c1dd2cda4fa515503a88c9c4551",
          "worktree_digest": "sha256:26cb8cda349d9d67f65cd9179323947596724c1dd2cda4fa515503a88c9c4551",
          "untracked_digest": "absent"
        },
        {
          "path": "tests/auth.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:86ba01412f1f4af53535d4ed69a72a5159941d500be580a98792fd1582205267",
          "index_digest": "sha256:86ba01412f1f4af53535d4ed69a72a5159941d500be580a98792fd1582205267",
          "worktree_digest": "sha256:86ba01412f1f4af53535d4ed69a72a5159941d500be580a98792fd1582205267",
          "untracked_digest": "absent"
        },
        {
          "path": "tests/product.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:d4bb074eb6968846668608421aa82ace0d925e0fe8c519691bfbc08cc28e784b",
          "index_digest": "sha256:d4bb074eb6968846668608421aa82ace0d925e0fe8c519691bfbc08cc28e784b",
          "worktree_digest": "sha256:d4bb074eb6968846668608421aa82ace0d925e0fe8c519691bfbc08cc28e784b",
          "untracked_digest": "absent"
        },
        {
          "path": "tests/runner.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:7953b7246b9542e7d46cf35ae371e436a82657b40ee8be005b69ede12dc2d12b",
          "index_digest": "sha256:7953b7246b9542e7d46cf35ae371e436a82657b40ee8be005b69ede12dc2d12b",
          "worktree_digest": "sha256:7953b7246b9542e7d46cf35ae371e436a82657b40ee8be005b69ede12dc2d12b",
          "untracked_digest": "absent"
        }
      ]
    },
    "acceptance_criteria": [
      "六项有可用入口及离线验证",
      "旧数据和未知时间不伪造",
      "不改变参与、预算、认证、风控规则"
    ],
    "files_to_modify": [
      "src/main/auth-service.ts",
      "src/main/auth-probe.ts",
      "src/main/auto-runner.ts",
      "src/main/runtime.ts",
      "src/main/execution-gate.ts",
      "src/main/runtime-repository.ts",
      "src/main/application.ts",
      "src/main/ipc-handlers.ts",
      "src/shared/review.ts",
      "src/shared/policy.ts",
      "src/renderer/src/components/SettingsView.vue",
      "src/renderer/src/components/ActivityLog.vue",
      "src/renderer/src/components/RecordsView.vue",
      "src/renderer/src/components/ReviewSummary.vue",
      "src/renderer/src/composables/useIpc.ts",
      "src/preload/index.ts",
      "package.json",
      "tests/auth.test.ts",
      "tests/auth-probe.test.ts",
      "tests/product.test.ts",
      "tests/runner.test.ts",
      "scripts/ui-smoke.cjs"
    ],
    "tests": [
      {
        "file": "tests/experience.test.ts",
        "scenarios": [
          "等待状态取消与未知时间",
          "耗时采样短间隔、挂起和倒退",
          "配置差异、日志精确过滤及脱敏"
        ]
      },
      {
        "file": "tests/auth.test.ts",
        "scenarios": [
          "诊断代次隔离、成功失败与取消"
        ]
      },
      {
        "file": "scripts/ui-smoke.cjs",
        "scenarios": [
          "诊断、设置摘要、运行回顾、日志联动、窗口说明和窄窗口"
        ]
      }
    ],
    "verification_commands": [
      "npm run typecheck",
      "npm test",
      "npm run test:smoke"
    ],
    "pdg_constraints": [
      "await后保留signal与generation检查",
      "probe自然响应先监听后导航且finally清理",
      "导航readyAt只采样一次"
    ],
    "assumptions": [
      "历史报告没有细分耗时，必须标未采集",
      "日志只有本次应用打开最近500条，不据空结果推断无动作"
    ],
    "open_questions": [],
    "avoid": [
      "真实评论关注付款测试",
      "主动调用私有接口",
      "打包",
      "推断旧runId",
      "自动恢复风险"
    ]
  }
}
```
## 12. 假设与未决
无阻塞问题。历史缺细分耗时不得补算；日志不是历史审计轨迹。深色主题、自动策略优化和无关重构不在范围。规划写入首试遇到stdin EAGAIN，改为外部临时文件输入同一安全writer，不绕过writer。

## 13. 完成标准
六项落地可演示；新增和原回归通过；截图/临时数据留忽略目录；无真实账号动作、无安装包。仅在后续用户要求时提交Git。
