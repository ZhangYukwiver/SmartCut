# 拆片工坊 SmartCut

说说想怎么剪，AI 在时间线上帮你剪好，再一键放进剪映草稿箱精修；看到一条好视频，交给它拆成可复用的拍法。

拆片工坊是一个跑在自己电脑上的桌面应用（macOS Apple Silicon、Windows x64）。它原来是「内容数据工作台」里的 AI 视频工作台，现在拆出来单独发布。模型用你自己的：OpenAI 兼容接口（默认火山方舟），或者这台电脑上装好并登录的 Codex、Claude Code。

## 能做什么

| 功能 | 说明 |
| --- | --- |
| AI 剪辑看板 | 页面照剪辑软件排：左边和 AI 对话、翻素材，中间播放器，右边属性面板，底下整条时间线。AI 剪的每一步都实时出现在上面：剪切拼接、字幕和文字、特效、滤镜、转场、动画、关键帧（带剪映的关键帧曲线：缓入、缓出、回弹、自定义）、曲线变速（蒙太奇、英雄时刻、子弹时间等预设，也能自己拖速度点）、背景音乐。你也能自己动手：拖、裁、切、复制、跨轨道挪，在画面上直接挪位置、缩放、旋转、改字；每一步都能撤销，也能退回到某句话之前；在画面上框一块，让 AI 只改框里的东西 |
| 导出剪映草稿 | 做好后一键导入剪映草稿箱继续精修；再次导入前会检查剪映里那份草稿有没有被改过，由你选另存还是覆盖。左栏「剪映素材」能翻剪映内置的转场、滤镜、特效、动画和字体，选中片段点一下就加上。导入前要先退出剪映，macOS 版剪映 11.6 实测过 |
| 网页片段出 MP4 | 剪映做不出的画面（标题字卡、动态大字、数据图表、倒计时），AI 写成网页片段，看板上实时预览，导入剪映时自动渲成视频，带透明的叠在画面上。不经剪映也能直接导出 MP4（可选成片响度 -14/-15/-16 LUFS、真峰值压在 -2 dBTP 以下，标成旁白的轨响起来时配乐自动让位，画质分高/标准/小三档），或者导出、导入网页工程（film.html 打成的 zip）。编码用浏览器自带的 WebCodecs，不带 ffmpeg |
| 参考复刻与自动校准 | 复刻入口按画面选择可编辑图层或网页动画。已有网页动画点「自动校准」后，先根据连续画面判断合成结构，再做局部修改。问题前后的 2–4 秒短片按当前时间线完整合成，透明叠加层与底层视频一起复核；明确改善且无回退后采纳，时间线或依赖素材变化后旧结论失效。最近 6 份候选与评审跨轮保留，相同材料和问题复用结论。每轮最多 4 次视频复核，连续两份不同内容无改善时停止；不盲调参数、不反复导出全片。对话展示视觉模型的本轮及累计用量、已知价格估算。视频不可读时明确运动未验证，短片通过不代表全片逐帧一致 |
| 生成图片和视频 | 素材里没有的画面，AI 能现做：图片走 OpenAI 兼容的图片接口，视频可以用火山方舟 Seedance、即梦、小云雀或 LibTV。生成视频前先在页面上问你，你点了「生成」才开始扣费 |
| 图片自动抠图 | 素材栏里的照片点「自动抠图」，或告诉 AI「把这张图的主体抠出来」，在本机自动识别主要人像、物体并去背景。生成同尺寸透明 PNG 加入素材库，原图保留；可叠到时间线上，或让 AI 替换指定图片片段。首次下载约 192MB 模型，之后可离线使用，无需 Key。支持 JPG、PNG、WebP（50MB、4000 万像素以内）；发丝、透明物体和复杂背景的效果依图片而异 |
| 图片精修与去字 | 素材栏图片上的「精修 / 去字」可用擦除、恢复画笔修整抠图残留，支持缩放、原图对比、撤销和重做（精修画布支持 50MB、1600 万像素以内）。涂出字幕后点「修复选区」，LaMa 在本机补全选区纹理（首次下载约 208MB）；只修改选区内颜色，保留透明度和选区外像素。结果另存为新素材，原图和之前的结果保留；新素材可引用给 AI 替换指定图片片段。修复是模型推测，复杂文字和图案可能需要分小块处理 |
| 视频解析库 | 拆解一条视频的选题、开头钩子、结构、画面声音和可复用拍法，并说明每段为什么这样拍；结果存进可搜索的解析库。模型看不了视频时，应用在本机把视频拆成镜头截图、镜头表和音乐节拍再交给它（这时听不到台词） |
| 技能 | 装带 `SKILL.md` 的技能包（填 GitHub 地址或选本机文件夹），AI 照说明读写技能文件、在这台电脑上跑命令，把做出来的音频、图片、视频放进素材库。每条命令先问你，点了「运行」才跑。本机文件夹整份拷进应用，原文件夹挪走不影响；技能里的 `page-files/`（动画引擎、字体、背景图）拷给网页片段共用，页面写 `../_skills/<技能 id>/…` 引用 |
| 本机 Codex / Claude Code | 不想配接口就用这台电脑上登录好的 Codex 或 Claude Code，走你自己的订阅。应用用不留会话、关掉它们自带的命令行和读写文件工具的方式调用，剪辑工具经一个只在本机、每轮随机密钥的 MCP 端点交给它们。它们看不了视频，看的是应用拆出来的截图和节拍 |
| 送件 | 别的应用可以把一条视频直接送进来：送来的视频进素材库，拆片工坊切到「AI 解析」，模型配好了就直接开始解析。做法见 [送件约定](docs/handoff.md) |

## 安装

到 [Releases](https://github.com/ZhangYukwiver/SmartCut/releases/latest) 下载：

- **macOS（Apple Silicon）**：`SmartCut-<版本>-arm64.dmg`，拖进「应用程序」。安装包没有开发者签名，第一次打开前在终端执行一次 `xattr -cr "/Applications/SmartCut.app"`，不然会提示应用已损坏。Mac 版不能在应用里自动更新，新版本按同样步骤替换。
- **Windows**：`SmartCut-Setup-<版本>.exe`。出现 SmartScreen 提示时点「更多信息」再点「仍要运行」。之后的新版本可以在应用里直接更新。

关掉窗口只是收进托盘（macOS 是菜单栏），剪辑、生成和解析在后台接着跑；要完全退出，在图标菜单里点「退出」。

用过原来内容数据工作台里 AI 视频工作台的，第一次打开拆片工坊时会自动把工程、会话、素材、技能和解析记录拷过来，原来的数据不动。接口 Key 原来存在旧应用的页面里，拷不过来，要在设置里重新填。

## 从源码运行

需要 Node.js 24。

```bash
npm ci
npm run desktop          # 打包页面并用 Electron 打开桌面版
npm run server           # 只起本机服务（默认 127.0.0.1:4865），打印配对码
npm run web              # 页面开发服务器，配合 npm run server 在浏览器里用
npm test                 # 全部测试
npm run typecheck
npm run desktop:build    # Windows 安装包（NSIS）
npm run desktop:build:mac
```

`npm run server -- --help` 看服务的参数（端口、允许的来源、局域网）。单独跑服务时，网页片段用本机的 Chrome / Edge 无头渲染，可以用环境变量 `REELLAB_FILM_BROWSER` 指定浏览器。

## 数据放在哪

桌面版的数据目录沿用改名前的 `<appData>/ReelLab`（macOS `~/Library/Application Support/ReelLab`，Windows `%APPDATA%\ReelLab`）：

- `data/ai-edit/`：剪辑会话、工程、素材库（`media/`）、工程存档（`checkpoints/`）、网页片段（`pages/`，技能带的共用文件在 `pages/_skills/`）、导出的 MP4 和工程包（`renders/`）、技能（`skills.json`、`skills/`、`skill-work/`）
- `data/analyses.json`：解析库
- `data/local-ai/`：调用本机 Codex / Claude Code 时的工作目录和临时文件
- `inbox/`：别的应用送来、还没导进素材库的视频

从源码单独跑 `npm run server` 时，数据在仓库下的 `.local-data/`。

## 隐私

- 接口 Key（包括生成图片、视频用的）只存在这台电脑上应用页面的本地设置里，每次随请求交给本机服务，只在请求里用，不写进数据目录、日志和报错。
- 本机服务只监听 127.0.0.1，页面要先配对拿到令牌才能调接口；素材文件地址用独立的密钥。AI 写的网页片段由本机服务放出去，它们取不了配对码、配不了对，拿到令牌也调不了要配对的接口，替不了你点「生成」或「运行」。
- 和 AI 对话时，你的消息、素材清单（名称、时长、尺寸，送来的视频还带作者）和当前时间线会发到你配置的接口。素材文件本身不上传，例外是贴进对话的图片（发一份压缩预览）、让 AI 解析参考视频或转写字幕时的那条视频（超过 45MB 的先在本机压一份小的），以及生成图片、视频时选作参考的图片。模型看不了视频时只发本机拆出来的截图、镜头表和节拍。
- 自动抠图只在本机处理照片。首次从 Hugging Face 下载并校验固定版本的 BiRefNet_lite 权重，缓存到 `data/ai-edit/models/`；抠图过程不上传照片。
- 手动图片精修和去字只把图片、选区发给本机服务；LaMa 权重同样下载并校验到 `data/ai-edit/models/`。让 AI 自动去字时，修复仍在本机执行，修复前后截图会交给配置的视觉模型检查残字和纹理；网页预览发送候选、参考及修改前正式版的同刻截图，运动复核则发送对齐并裁切的短视频，分别判断改善、回退和剩余差距。短片不包含音轨。
- 解析时，视频、它附带的标题和作者等信息、提示词会发到解析用的接口；结果属于模型生成的内容，要结合原视频判断。
- 装了技能时，技能的说明、AI 读到的技能文件和命令输出会发到剪辑接口；技能命令在你的电脑上运行，联不联网由技能自己决定，所以每条都先问你。
- 用本机 Codex / Claude Code 时，文字、图片和工具结果由它们用你的订阅和网络配置发给 OpenAI 或 Anthropic。

## 许可证与致谢

拆片工坊本身以 [MIT](LICENSE) 许可证发布。用到的第三方代码：

- [pyJianYingDraft](https://github.com/GuanYixuan/pyJianYingDraft)（Apache-2.0）：剪映草稿的结构、特效 / 滤镜 / 转场 / 动画等目录，草稿生成和草稿箱写入照它和 [JianYingAPI](https://github.com/ZhangYukwiver/JianYingAPI) 用 Node 重写，不需要 Python 和 ffprobe。许可证见 [server/licenses/pyJianYingDraft-Apache-2.0.txt](server/licenses/pyJianYingDraft-Apache-2.0.txt)。
- [OpenFilm](https://github.com/openfilm/openfilm)（MIT）：网页片段的宿主约定、film.html 的读写和播放（`server/aiEdit/film/vendor/`、`film/host.mjs`）用的是它的代码，出片逐帧截图的做法，以及 AI 剪辑里时间线、右键菜单、属性输入和快捷键的部分交互也照它来。许可证见 [server/licenses/openfilm-LICENSE.txt](server/licenses/openfilm-LICENSE.txt)。
- [BiRefNet](https://github.com/ZhengPeng7/BiRefNet)（MIT）：自动抠图使用 [Studio Ludens 转换的 BiRefNet_lite 512 权重](https://huggingface.co/studioludens/birefnet-lite-512)，通过 ONNX Runtime 在本机运行。许可证见 [server/licenses/BiRefNet-MIT.txt](server/licenses/BiRefNet-MIT.txt)。
- [LaMa](https://github.com/advimman/lama)（Apache-2.0，Samsung Research）：局部去字使用 [Carve 转换的 big-lama ONNX 权重](https://huggingface.co/Carve/LaMa-ONNX)，在本机补全涂选区域。原始模型在 Places2 数据集上训练，数据集作者为 Bolei Zhou、Agata Lapedriza、Aditya Khosla、Aude Oliva 和 Antonio Torralba；参见 [Places 项目](http://places2.csail.mit.edu/)。许可证见 [server/licenses/LaMa-Apache-2.0.txt](server/licenses/LaMa-Apache-2.0.txt)。

本项目和剪映、火山方舟、OpenAI、Anthropic 及各视频生成服务都没有隶属或合作关系。
