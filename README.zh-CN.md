# ptyhub

**服务器端常驻的 PTY 会话守护进程，附带一个轻量但完整的 Web UI。**

[English](README.md) · [简体中文](README.zh-CN.md)

会话活在服务器的守护进程里，不在浏览器里。关掉网页、刷新、断网、手机休眠、重启 Web 网关，你跑着的东西都不受影响；换一台设备打开网页，回到的还是同一批终端。

不碰 Git，不碰 SSH，底下没有 tmux，也不会写入 `~/.claude` 或 `~/.codex` 下的任何文件。

---

## 架构

```
ptyd（常驻，持有全部 PTY master fd）
  │
  ├── Unix socket ──→ web（HTTP/WS 网关，无状态，可随时重启）
  │                        ↑ HTTP/WebSocket
  │                   浏览器 / 手机 / 平板
  │
  └── Unix socket ──→ ptyhub CLI / TUI（本机终端直接 attach）
```

拆成两个进程不是偏好，是 PTY 的工作方式推导出来的。持有 PTY master 描述符的进程一旦退出，内核就会给 slave 端的前台进程组发 SIGHUP，shell 必死。所以**唯一**持有这些描述符的是 `ptyd`，它只管 PTY 的生命周期，完全不含 HTTP 代码。网关是无状态的：重建前端、改 API、升级、甚至崩溃，都不会惊动任何一个 shell。

`ptyd` 自己挂掉会话就没了，这点和 tmux server 一样，不做隐瞒。它的职责只有六件事——创建、读输出、写输入、resize、报告退出、接受订阅者——所以很少需要改动。

**和 tmux 的区别**：tmux server 内部实现了一整套终端仿真，解析转义序列、维护虚拟屏幕、再重新生成序列发给客户端。这层转译正是真彩色、鼠标上报和特殊字符出问题的地方。`ptyd` 不做转译，原始字节流直接交给浏览器里的 xterm.js，终端仿真只发生一次。

**重连**不是从字节流的某个位置开始重放——那会把全屏程序放花。`ptyd` 为每个会话维护一份无头终端（`@xterm/headless`），重连时序列化出能精确重建当前画面的那段序列。刷新页面后 vim 还是 vim，htop 还是 htop。

---

## 安装

```bash
git clone <你的仓库> ~/ptyhub && cd ~/ptyhub
npm install
npm run build                      # 构建 Web UI 到 public/
node bin/ptyhub.mjs install-service
systemctl --user daemon-reload
systemctl --user enable --now ptyhub-ptyd ptyhub-web
loginctl enable-linger "$USER"     # 开机自启、退出登录不被杀
```

把 CLI 放进 PATH：

```bash
ln -s ~/ptyhub/bin/ptyhub.mjs ~/.local/bin/ptyhub
```

然后拿一条可以打开的链接：

```bash
ptyhub link          # 打印带访问令牌的 URL
ptyhub link --qr     # 顺便打印二维码，手机扫一下就绑定
```

默认监听 `127.0.0.1:7420`。从自己电脑访问先开隧道：

```bash
ssh -N -L 7420:127.0.0.1:7420 你的服务器
```

需要 Node 22 或更新版本。`node-pty` 装的是预编译二进制，不需要编译工具链。

---

## 安全

**在共享机器上，回环地址不是安全边界。** 集群登录节点或任何有多个账号的机器上，每个本地用户都能连 `127.0.0.1:7420`，而这个服务发的是 shell。所以这里不存在"免认证"模式：

- 没设密码时，首次启动会生成一个常驻访问令牌写进 `~/.local/state/ptyhub/token.json`（权限 0600），并打印带令牌的 URL。打开一次，这台设备就授权 90 天，之后访问裸地址即可。
- `ptyhub passwd` 切换成账号密码。令牌立即作废，已授权的设备不受影响。
- `ptyhub link --qr` 为手机和平板生成一次性配对链接。密钥放在 URL 的 `#` 片段而不是查询参数，因此不会进服务端日志，也不会出现在 Referer 里。
- 只有在配置里显式写 `"trustedNetwork": true` 才会完全关闭认证。仅在网络层已经做了鉴权时使用，比如只在 WireGuard 或 Tailscale 接口上暴露。

设备凭证只存 SHA-256 哈希并定期轮换。在宽限期之后出现已作废的凭证，说明 cookie 被复制过，于是直接吊销该设备的整条链，而不是默默放行。设置页的 Devices 标签列出全部已授权浏览器，可以逐个吊销。

WebSocket 握手会校验 `Origin`——不校验的话，你访问的任何网站都能打开一个通往你 shell 的 socket，因为 SameSite 对 WebSocket 握手的保护并不完整。REST 靠 SameSite 加同一套 Origin 校验。登录失败按来源 IP 指数退避，连续十次锁十五分钟。

说白了：任何拿到凭证的人就等于是服务器上的你。要对外暴露就在前面挂 Caddy 或走 Tailscale。

---

## Web UI

顶部是标签栏，左侧是可折叠的会话面板，主区支持任意深度的水平和垂直分屏。

每个标签显示会话名和**当前前台进程**，所以你看到的是 `claude`、`htop`、`vim`，而不是永远的 `bash`。后台会话产生了你还没看的输出时，标签上会亮一个小圆点。

**标签可以拖动。** 在标签栏内拖到别处就是改顺序，顺序存在服务端，跟着你到其它设备。拖到某个窗格上就是在那里显示它；拖到窗格边缘则是在那一侧分屏并把终端放进新窗格。拖动过程中会实时预览落点后的结果。

**在标签上右键**（触屏长按）可以重命名、置顶、锁定、分屏、关闭。

**锁定**保护会话不被关闭。它由 `ptyd` 强制执行而不是靠界面：`ptyhub kill` 同样会被拒绝，其它浏览器也都看得到这个锁。跑长任务时给它上个锁，就不会被一次误点毁掉。要绕过它得显式用 `ptyhub kill --force`。

**置顶**把会话固定在标签栏最前面。

关闭终端是一次点击的事，标签立刻消失，窗格自动显示下一个终端，像浏览器关标签页那样。自己退出的会话会留在列表里显示退出码——那时退出码才值得看。

### 多设备尺寸

终端跟着窗口走。拖浏览器、折叠侧栏、拖分隔条、手机横竖屏切换，`tput cols` 立刻是新值。

多台设备同看一个会话时，尺寸跟随**你正在用的那台**。点进某个窗格或者在里面打字，就等于把会话认领到这台设备；切回另一台再点一下就拿回来。

手机默认按自己的屏幕排版，文字可读。如果只想旁观电脑上的会话而不改变它，把设置切成 *Watch*，那时手机保持电脑的列数、把整个画面等比缩小。

### 快捷键

有一个总开关（设置 → Keyboard → "Enable keyboard shortcuts"）。关掉之后 ptyhub 什么都不拦截，就是一个普通网页，给不想被任何按键劫持的人用。

**这个总开关和 Mac 风格那层自己的开关，都只存在你设置它的那个浏览器里，不会同步。** 一个窗口该不该拦截按键，取决于这个窗口本身是什么（普通标签页，还是你那种没有快捷键的 app 模式壳），这是设备的属性，不是那种想同步到每台登录设备的偏好，所以它们存在那个浏览器的 `localStorage` 里。除了这两个开关，其余部分——leader 键、两层里每个键具体绑的是什么——照常跨设备同步，和主题字体一样。

开着的时候有两层，各自独立：

**Leader 快捷键**，默认开启：都是 leader 前缀键加一个键，所以不从浏览器或 shell 那里抢任何东西，是普通浏览器标签页下的安全默认值。默认 leader 是 `Ctrl+\`，和 `ptyhub attach` 的脱离前缀一致。

| 键 | 作用 | | 键 | 作用 |
|---|---|---|---|---|
| `c` | 新建终端 | | `\|` 或 `\` | 向右分屏 |
| `x` | 关闭终端 | | `-` | 向下分屏 |
| `r` | 重命名 | | `w` | 关闭当前窗格 |
| `n` / `p` | 下一个 / 上一个 | | `o` | 切换窗格 |
| `1`–`9` | 按序号切换 | | `f` | 在终端里搜索 |
| `b` | 开关侧栏 | | `k` | 命令面板 |
| `+` / `_` / `0` | 字号加 / 减 / 复位 | | `l` | 清屏 |
| `,` | 设置 | | | |

**Mac 风格直达快捷键**，默认关闭：单个修饰键加一个键立刻触发，不需要 leader——`⌘W` 关闭、`⌘1` 跳到第 1 个终端，就是原生 Mac 应用的样子。每一条都同时绑在 `⌘` 和 `Ctrl` 上，用哪个当主修饰键都行。默认值抄的是已有的成熟约定，不是自己发明的：标签生命周期和切换对齐 iTerm2/Terminal.app（`⌘T`/`⌘W`、`⌘D` 和 `⇧⌘D` 分屏、`⇧⌘[`/`⇧⌘]` 切上一个/下一个、`⌘K` 清屏），其余对齐 Mac 应用的通用惯例（`⌘,` 偏好设置、`⌘F` 查找、`⌘B` 开关侧栏、`⇧⌘P` 命令面板——和 VS Code 一样、`⌘=`/`⌘-`/`⌘0` 缩放）。

在普通浏览器标签页里，`⌘/Ctrl+W`、`+T`、`+N` 是浏览器自己保留的组合键——这是故意设计成网页 JS 拦不住的，为的是不让恶意网站把你困在一个关不掉的标签页里。设置页会把这几条标成"仅限 app 模式"：它们只在已安装的 PWA 独立窗口，或者以 app/kiosk 模式启动、没有标签栏的浏览器窗口里才生效，这正是它们的设计场景。如果你是这么用 ptyhub 的就打开这层；普通标签页里开着也没关系，那几个组合键在那种环境下本来就什么都不会发生。

整份键位（总开关、leader、两套直达绑定）都存在 `~/.config/ptyhub/keymap.json`，在设置页的 Keyboard 标签里可改。

**不要把 leader 设成 `Ctrl+Space`。** 那是 Windows、macOS、Linux 上输入法的中英文切换键；对于用中日韩输入法的人，这个按键根本到不了网页，所有快捷键都会无声失效。设置页会对两层里已知会被吞掉的组合都给出警告。

### 移动端

会话切换收进底部弹层，并出现一条虚拟按键条——手机键盘没有 Esc、Tab、Ctrl 和方向键，缺了它们 vim 和任何交互式命令行都没法用。Ctrl 和 Alt 是一次性锁定。软键盘弹出时终端会收缩而不是被盖住。"添加到主屏幕"后是没有地址栏的独立窗口。

### 外观

主题、字体、字号、行高、字间距、连字、光标形状与闪烁、回滚行数、选中即复制、右键粘贴、链接可点击，全部即时生效并存在服务端，换设备自动继承。字号按设备类别分别记忆，电脑上调大不会把手机弄难看。

内置主题：One Dark、Tokyo Night、Dracula、Solarized（深浅两套）、GitHub Light，外加两套 ptyhub 自带配色。界面外壳和终端调色板来自同一组令牌，所以换主题是整体换，不会各走各的。

提示符里的 powerline 图标需要 Nerd Font：在服务器上跑 `ptyhub fetch-font nerd`，然后在设置页 Font 标签打开 "Nerd Font glyphs"。打开连字会切到 DOM 渲染器，因为 WebGL 渲染器画不了连字——这是那个开关背后唯一的取舍。

标签图标默认是静态的。打开 "Animate the tab icon" 后它会改为反映连接状态和未读输出。

---

## 命令行

不带参数运行 `ptyhub` 会进入会话选择器：方向键或 `j`/`k` 移动，Enter 进入，`n` 新建，`x` 关闭，`r` 改名，`/` 过滤，`q` 退出。

| 命令 | 作用 |
|---|---|
| `ptyhub ls` | 列出会话 |
| `ptyhub new [名字] [-- 命令…]` | 新建并直接进入 |
| `ptyhub attach <id\|名字>` | 接管一个会话 |
| `ptyhub kill [--force] <id\|名字>` | 关闭 |
| `ptyhub lock <id\|名字>` | 保护它不被关闭 |
| `ptyhub unlock <id\|名字>` | 解除保护 |
| `ptyhub rename <id> <新名字>` | 改名 |
| `ptyhub status` | 守护进程、会话数、认证方式 |
| `ptyhub passwd` | 设置 Web 密码 |
| `ptyhub link [--qr]` | 访问或配对链接 |
| `ptyhub fetch-font nerd` | 下载 Nerd Font 供 UI 使用 |
| `ptyhub install-service` | 生成 systemd --user unit |

会话可以用完整 id、id 前缀或名字指定。attach 之后 `Ctrl+\` 再按 `d` 脱离，一切继续运行；连按两次 `Ctrl+\` 发送一个字面量字节。这里 attach 的和浏览器里看到的是同一个会话，两边输入实时互见。

---

## 服务管理

```bash
systemctl --user status  ptyhub-ptyd ptyhub-web
systemctl --user restart ptyhub-web     # 会话不受影响，浏览器自动重连
systemctl --user restart ptyhub-ptyd    # 会杀掉全部会话，很少需要
```

改了前端代码跑 `npm run build` 然后刷新浏览器；网关按请求读文件，不用重启。

有些系统上普通用户读不了 `journalctl`，所以两个守护进程也各自写一份日志到 `~/.local/state/ptyhub/web.log` 和 `ptyd.log`。

---

## 数据存放位置

仓库里不存任何数据。

| 路径 | 内容 | 权限 |
|---|---|---|
| `~/.config/ptyhub/config.json` | 监听地址、端口、shell、resize 策略 | 0644 |
| `~/.config/ptyhub/auth.json` | 用户名与 scrypt 哈希（不存明文密码） | 0600 |
| `~/.config/ptyhub/keymap.json` | leader 键与绑定 | 0644 |
| `~/.config/ptyhub/prefs.json` | 主题、字体、布局、标签顺序、置顶 | 0644 |
| `~/.local/state/ptyhub/token.json` | 未设密码时的常驻访问令牌 | 0600 |
| `~/.local/state/ptyhub/devices.json` | 设备凭证哈希、标签、地址 | 0600 |
| `~/.local/state/ptyhub/sessions.json` | 会话元数据镜像，仅供查看 | 0600 |
| `$XDG_RUNTIME_DIR/ptyhub/ptyd.sock` | IPC socket | 0600 |

`config.json` 常用项：

```jsonc
{
  "bind": "127.0.0.1",      // 改成非回环地址前请先设密码
  "port": 7420,
  "shell": null,            // null = $SHELL
  "shellArgs": ["-l"],
  "scrollback": 10000,
  "autoCreateFirstSession": true,
  "resizePolicy": "active", // "active" 跟随正在用的设备，"min" 取最小值
  "reviveScreen": true,     // 精确重建画面；关掉则退回原始字节重放
  "trustedNetwork": false,  // true 完全关闭认证
  "allowedOrigins": []      // 反向代理的额外来源
}
```

子进程拿到的环境是 `ptyd` 自己的环境加上 `TERM=xterm-256color` 和 `COLORTERM=truecolor`，不多不少。

---

## 排错

**快捷键没反应。** 先确认 leader 不是 `Ctrl+Space`，见上面的快捷键一节。

**终端很小，缩在角落。** 另一台设备把会话调窄了。在你这边点一下终端，尺寸就回到你的窗口大小。

**提示符里的图标是方框。** 缺 Nerd Font，跑 `ptyhub fetch-font nerd`。

**状态胶囊变琥珀或红色。** 琥珀是正在重连，红色是网关连不上 `ptyd`。两种情况下跑着的东西都不会丢。

**没设密码却出现登录页。** 这台设备还没授权，在服务器上跑 `ptyhub link`。

---

## 开发

```bash
npm run ptyd       # 前台跑守护进程
npm run web        # 前台跑网关
npm run dev        # Vite 开发服务器（7421），代理 /api 和 /ws
npm run build
npm run icons      # 从 web/assets/icon.svg 重新生成图标
npm run typecheck
npm test           # 全部四套端到端测试
```

所有测试都是针对真实进程的端到端测试，跑在一次性的 XDG 目录里，不会碰到真实配置。

| 套件 | 覆盖 |
|---|---|
| `test:ptyd` | 会话生命周期、画面恢复、尺寸协调、锁定、观看者互不影响 |
| `test:web` | REST、WebSocket、三条认证路径、跨站拒绝、网关重启 |
| `test:cli` | 真实 PTY 里的 `attach`、脱离序列、选择器、锁定拒绝 |
| `test:ui` | 无头 Chromium 驱动真实界面：输入、尺寸、恢复、快捷键、主题、标签拖拽、移动端 |

---

## 许可证

MIT，见 [LICENSE](LICENSE)。
