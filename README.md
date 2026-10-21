# 数见 DataLens

电商经营分析产品 Demo，串联指标看板、自然语言问数、数据工具、证据核对和人工确认待办。支持模拟店铺与自定义 SQL / CSV 数据。深色界面提供交互趋势图、筛选联动与分析状态动效；系统设置减少动态效果时会关闭动画。默认数据不代表真实业务效果。

本版本包含完整网页与 Node 后端，可从 GitHub 部署到 Render。GitHub 保存源码；Render 运行网页和 DeepSeek 接口，生成一个可访问的 HTTPS 网址。未解锁的访客仍可浏览看板和使用本地规则模式，输入展示口令后使用站点配置的真实模型。

## 在线部署：GitHub + Render

1. 注册 GitHub，新建仓库（例如 datalens-ai-demo），上传解压后的全部目录及文件。仓库根目录必须能看到 package.json、server.mjs 和 render.yaml；不要只上传 ZIP。保留 .gitignore 与空白 .env.example，不上传本机 .env。
2. 注册并登录 Render，在 New → Blueprint 中连接该 GitHub 仓库，选择 main 分支，读取根目录 render.yaml。为 GitHub 授权时只选择这个仓库。
3. Blueprint 会要求填写两个环境变量：DEEPSEEK_API_KEY 填你的官方平台 Key；DEMO_ACCESS_CODE 填至少 16 个字符的随机展示口令。两者只填写在 Render 控制台，不提交到仓库。展示口令与 API Key 必须不同。
4. 检查服务类型为 Web Service、Node、Free，然后创建。配置默认使用免费实例，模型调用仍由你的 DeepSeek 账户付费。以平台实际可用方案及账单提示为准。
5. 部署状态为 Live 后，打开 Render 提供的 HTTPS 地址。进入模型连接页，输入展示口令，点击验证真实分析；看到实际工具结果后再分享网址。

如果不使用 Blueprint，可手动选择 New → Web Service 并连接仓库：Language=Node，Build Command=npm test，Start Command=npm start，Health Check Path=/healthz，实例数量为 1；设置下表环境变量。

| 变量 | 值 / 填写位置 |
| --- | --- |
| NODE_VERSION | 22 |
| SKIP_INSTALL_DEPS | true（无外部依赖） |
| DEPLOYMENT_MODE | cloud |
| DEEPSEEK_MODEL | deepseek-flash |
| DEEPSEEK_API_KEY | 你自己的 Key，仅填 Render 环境变量 |
| DEMO_ACCESS_CODE | 至少 16 字符的随机展示口令，仅填 Render 环境变量 |
| DEMO_MAX_ANALYSES | 30（单个服务进程启动后的分析次数上限） |

Render 自动提供 PORT 和 RENDER_EXTERNAL_URL，本项目直接使用。不要把 127.0.0.1 填为线上域名。自定义域名或其他 Node 平台可设置 PUBLIC_ORIGIN 为准确的 HTTPS origin（仅协议、域名和可选端口，没有路径）；前端与 API 必须在同一来源。

GitHub Pages 仅运行静态前端，无法运行本项目的 Node 后端。在 GitHub 的 About → Website 中填写 Render 提供的网址，访客即可从仓库进入完整在线体验。若启用 Pages，只有本地规则模式可用。

## 展示访问与调用控制

- 展示口令解锁后生成最多 4 小时的服务端会话，浏览器保存 HttpOnly、Secure、SameSite=Strict 的 Cookie。口令不会写入 localStorage 或 URL。退出会清除本次会话。
- 模型密钥只由后端使用，页面不收集或返回模型 Key。云端模式忽略本机 .env，只读取平台环境变量；更改平台变量后按平台流程重新部署。
- 同时最多 1 条分析，整个进程每分钟最多 6 次；默认本次进程启动后累计最多 30 次有效提交的分析，失败的分析也可能占用次数。单次分析最多请求模型 3 次，单次上游请求限时 30 秒。
- 30 次计数保存在进程内存，重启、重新部署或免费实例休眠后唤醒可能重置；它不是持久化每日配额，也不是平台账单硬上限。部署保持单实例。实际费用需查看 DeepSeek 平台；演示结束后可暂停服务或更换专用 Key。
- 这是小规模、受口令保护的演示部署，不含生产级多租户、持久化配额和审计系统。

Render Free 服务闲置 15 分钟会休眠，再次访问通常约需 1 分钟唤醒。展示前提前打开网址、解锁并完成一条真实分析；不要把首次唤醒时间当成模型响应时间。免费实例可随时重启，需重新解锁。账号区域可用性和访问速度需在实际展示网络中验收。

## 本地体验

安装 Node.js 20–24（推荐 22），在项目目录执行 npm start，或 Windows 双击“启动数见.cmd”，打开 http://127.0.0.1:8766/。无第三方依赖，无需 npm install。默认仅监听本机，不要求展示口令。

将 .env.example 复制为 .env，在本地填写 DEEPSEEK_API_KEY；保存后在模型连接页检测并验证。无 Key 时自动选择本地规则模式；规则模式支持看板、周期/渠道筛选、有限问法、证据、人工待办、SQL / CSV 导入与导出。若系统环境中已设置 DEPLOYMENT_MODE=cloud，请先清除此变量后再本地启动。

## 导入自己的经营数据

1. 打开“数据与口径”，选择“导入数据”。选择文件后，确认临时上传并解析。
2. SQL 文件含多张表时选择一张，核对日期、渠道、访问次数、支付订单、成交金额、广告消耗这 6 项字段映射。原始列名可不同；未映射的列不会进入分析数据集。
3. 确认导入后，看板、渠道筛选、趋势、AI 问数、证据与报告使用这份数据。切换至真实 AI 模式即可走与模拟数据一致的工具调用流程。
4. 可以先下载 public/sample-data.sql 或 public/sample-data.csv 试用。切换回内置数据请点击“恢复演示”。

SQL 仅解析 CREATE TABLE 与 INSERT INTO ... VALUES 的字面量数据；不执行 SQL、不连接数据库、不支持 SELECT、UPDATE、DROP、SET、COPY、存储过程或表达式。常见 CREATE 表尾 ENGINE、CHARSET、COLLATE、AUTO_INCREMENT 选项可以解析。完整数据库 dump 如果含其他命令，请导出所需表的 CREATE / INSERT 数据片段或 CSV。

单文件上限 1 MB，合计 5,000 行、8 张表、每表 32 列、单元格 512 字符；分析最多 100 个渠道。日期须为 1900–9999 年内的 YYYY-MM-DD，数值非负，访问次数和订单数为整数、订单不超过访问次数；每个日期与渠道只允许一行汇总记录。该版本面向电商经营指标，需要上述 6 项字段，尚不是任意业务数据库的通用分析器。

云端导入前需要展示口令。本地和云端均在服务端内存临时保存数据，每个浏览器会话仅保留最近一次解析与一个已激活数据集；1 小时到期、服务重启或云端退出登录后不可恢复，需要重新上传。页面刷新可恢复仍有效的数据集；浏览器仅保存数据集标识，不保存原始上传行。切换数据或导入失败不会冒充模拟数据的分析结果。

## 分析流程与数据边界

问题与筛选 → 模型选择 query_metrics / compare_channels → 后端校验参数并计算指标 → 模型解释 → 展示证据 → 人工确认行动。

模型负责理解和解释，数值事实由确定性计算结果直接展示。结构校验和证据 ID 校验不能保证解释一定正确，相关变化不证明因果。支持最近 7 / 14 / 30 天，以当前数据集的最新日期为终点；模拟数据终点是 2026-10-20。缺少完整同期记录时，保留已观察到的当前汇总、隐藏前期数值与变化率，并提示补齐数据。GMV 为未扣退款的支付金额，订单转化率=订单数/访问次数，ROAS 不等于利润 ROI。

真实分析会把提问、筛选、当前数据集的日期/渠道信息与已映射指标的必要聚合结果发送至 DeepSeek；不会发送原始 SQL、文件名或未映射字段。渠道很多时只向模型提供最多 20 个主要渠道的明细，但总指标仍覆盖全部渠道。请使用获准分享的汇总数据；导入前页面会说明处理范围。静态 GitHub Pages 没有后端，仅能本地导入规范列名的 CSV 并使用规则模式，不支持 SQL 或真实 AI。待办存于当前浏览器；产品不会调整广告预算或操作外部业务系统。

## 文件与测试

- public/：完整产品页面、交互与模拟 SQL / CSV。
- lib/：确定性指标引擎与受限数据文件解析器。
- server.mjs：本地/云端服务、访问控制与模型编排。
- tests/：模拟上游响应的程序回归测试，不消耗真实模型额度。
- render.yaml：Render 部署配置，不含真实密钥或口令。
- .env.example：本地空白配置模板。

运行 npm test。回归测试使用模拟模型响应，覆盖工具调用、指标计算、文件解析、数据集隔离、过期处理及访问控制；不等于模型准确率或真实云端性能评测。部署配置已准备，真正的 Render 发布与真实云端 API 连通性需要在你的账号中完成并验收。

## 官方参考

- [Render 部署 Node 服务](https://render.com/docs/deploy-node-express-app)
- [Blueprint 配置与部署](https://render.com/docs/infrastructure-as-code)
- [Render 环境变量](https://render.com/docs/configure-environment-variables)
- [Render 免费实例限制](https://render.com/docs/free)
- [GitHub Pages 说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
