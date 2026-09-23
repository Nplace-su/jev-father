# Jev Judger · 从夯到拉

用 Jev 评价基于 Jev 的项目。娱乐法庭，只审项目，不审人。

输入一个公开 GitHub 仓库链接，读一点 README 和代码，用 Jev 的结构化选择来判断：这次到底是用在刀刃上，还是强行接入？机器人项目加试职责边界。

## 运行

需要 Node.js 20.12+，没有第三方依赖，无需 npm install。

```sh
cp .env.example .env
# 在 .env 中填写 TYPESAFE_API_KEY
npm start
```

打开 <http://localhost:3210>。没有 key 也可以点击「先看一个虚构示例」，但不会对真实项目生成假评价。Key 只在后端读取；修改后重启。GitHub 优先使用 `GITHUB_TOKEN`，否则尝试复用本机 `gh auth login` 登录，仅在内存中读取 token；两者都没有时使用匿名额度。`JEV_MODEL` 默认 `jev-latest`。

## Jev native 的两轮 harness

```text
GitHub URL
  → 固定默认分支 commit，抽取最多 8 个文本文件
  → 第一次 Jev：共享 state，5 个独立 Choice
      适配度 / Jev 的用途 / 实际实现 / 宣传边界 / 机器人职责
  → 第二次 Jev：分项判断作为 state，1 个最终 Choice
      夯 / 顶级 / 人上人 / NPC / 拉 / 证据不足
  → 程序展示概率、档位和对应预写短评
```

最终档位由第二次 Jev Choice 直接产生，**不使用加权总分定档，也没有聊天模型生成长评**。两轮是因为同一请求内的问题独立，终审需要看到第一轮答案。分项置信度低于 0.45 时送审为 unknown，这个阈值是娱乐产品的启发式，不是校准保证。最后一轮低置信度保留 Jev 的选择，并标注摇摆判决。

机器人问题不强制真机，不因仿真扣分，主要看有没有把现成感知、规划或控制器的能力说成 Jev 的能力。合理集成可以获得好评价，没有消融不能直接推出“没价值”。

## 轻量边界

- 只受理公开 GitHub 仓库首页，暂不支持子目录、指定分支、私有仓库。
- 按文件名优先抽取 README、Jev/TypeSafe、控制与测试相关文件；每文件最多约 6200 字符。复杂仓库可能遗漏关键实现，界面列出实际材料、截断及读取失败。
- 不下载执行仓库，不自动打开其外链，不做查重或全面新颖性检索；不能证明抄袭、真机效果或性能优势。
- 待评材料和评分指令分开；提示模型忽略仓库内指令。提示注入仍是模型局限，不把这个玩具当严肃审计。
- 两次付费调用，无自动重试。界面可展开两轮原始请求/回答和各轮 token usage，或下载完整 JSON。导出不含 API key。
- 服务只监听本机，拒绝跨站请求，同时只审一个项目；目前没有部署鉴权、数据库或历史记录。

## 验证

```sh
npm test
```

测试覆盖 URL 边界、取证限制、commit 固定、格式校验、未知项处理、两轮调用衔接及最终档位确由 Choice 选择。离线测试使用 fixture，不证明真实 Jev 的判断质量；真实连通性需要自己的 API key。

核心文件：`lib/github.mjs` 取证，`lib/rubric.mjs` 题目与短评，`lib/judge.mjs` 两轮接口，`public/` 页面。

官方接口依据（2026-09-23 核对）：[HTTP API](https://docs.typesafe.ai/api)、[Choice](https://docs.typesafe.ai/primitives/choice)、[原子问题与代码组合](https://docs.typesafe.ai/introduction)。
