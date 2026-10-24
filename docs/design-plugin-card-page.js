// 台架评审稿的渲染脚本：由 .card-measure.mjs 注入 docs/design-plugin-card-mockup.html
// 三种版本的卡片都按 lib/client.js 的真实 DOM 结构生成，宽度/高度由浏览器现量，不写死。
(function () {
  const SEAL =
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.7 8.3l2.1 2.1 4.3-4.5" stroke="#fff" stroke-width="1.5" fill="none"/></svg>';
  const STAR =
    '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.6l1.9 4 4.4.5-3.3 2.9.9 4.3L8 11.1l-3.8 2.2.9-4.3L1.8 6.1l4.4-.5z"/></svg>';
  const host = (it) => String(it.npm).startsWith("@deepseek-ai/");
  const el = (cls, html) => {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    s.innerHTML = html == null ? "" : html;
    return s;
  };

  // ── 徽章行动宽策略：整枚优先，放不下的不出现，末尾给 +N ──────────────
  function trimRow(row, list) {
    const W = row.clientWidth;
    let used = 0;
    const gap = 5;
    const keep = [];
    for (const n of list) {
      row.append(n);
      const w = n.getBoundingClientRect().width;
      const need = used === 0 ? w : used + gap + w;
      if (need <= W) {
        used = need;
        keep.push(n);
      } else n.remove();
    }
    const hidden = list.length - keep.length;
    if (hidden > 0) {
      const more = el("dsh-mcp-pchip more", "+" + hidden);
      row.append(more);
      if (used + gap + more.getBoundingClientRect().width > W) {
        more.remove();
        const last = keep[keep.length - 1];
        if (last) {
          keep.pop();
          last.remove();
          row.append(more);
        } else row.append(more);
      }
    }
  }

  function chipsFor(it, variant) {
    const out = [];
    const cats = [];
    if (it.category && it.category !== "plugin") cats.push(it.category);
    for (const t of it.tags) if (!cats.includes(t)) cats.push(t);
    if (variant === "cur") {
      for (const c of cats.slice(0, 3)) out.push(el("dsh-mcp-pchip", c));
      if (cats.length > 3) out.push(el("dsh-mcp-pchip more", "+" + (cats.length - 3)));
      return out;
    }
    if (variant === "yi") {
      out.push(el("dsh-mcp-badge s-on dot", "dsh " + it.va));
      if (it.npm && it.npm !== it.name) out.push(el("dsh-mcp-badge mono", it.npm));
      for (const c of cats) out.push(el("dsh-mcp-badge", c));
      return out;
    }
    if (it.npm && it.npm !== it.name) out.push(el("dsh-mcp-pchip mono", it.npm));
    for (const c of cats) out.push(el("dsh-mcp-pchip", c));
    return out;
  }

  // 逐字照现网 wbFormatCount（lib/client.js:8418）
  const fmtCount = (n) => {
    const v = Number(n) || 0;
    if (v >= 1000000) return (v / 1000000).toFixed(v >= 10000000 ? 0 : 1) + "M";
    if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k";
    return String(v);
  };
  const FLAGS = {
    cur: { ver: false, detail: false, nowrap: false },
    jia: { ver: true, detail: false, nowrap: false },
    jia2: { ver: true, detail: true, nowrap: true },
    yi: { ver: false, detail: true, nowrap: false },
  };

  function footFor(it, variant) {
    const f = FLAGS[variant];
    const facts = el("dsh-mcp-pfacts");
    if (it.stars) {
      facts.append(el("star", STAR + "&nbsp;" + fmtCount(it.stars)), el("span", "sep", "·"));
    }
    const tail = el(null, f.ver ? "dsh " + it.va : "核验 " + it.lv);
    tail.setAttribute("title", f.ver ? "已验证 · dsh " + it.va : "上次核验 " + it.lv);
    facts.append(tail);
    const acts = el("dsh-mcp-wb-card-actions");
    acts.style.flex = "0 1 auto";
    if (f.nowrap) acts.style.flexWrap = "nowrap";
    if (f.detail && !host(it)) {
      const b = document.createElement("button");
      b.className = "dsh-mcp-btn";
      b.textContent = "详情";
      acts.append(b);
    }
    const btn = document.createElement("button");
    if (host(it)) {
      const s = el("dsh-mcp-phost", "宿主组件");
      acts.append(s);
    } else {
      btn.className = "dsh-mcp-pbtn" + (it.__installed ? " installed" : "");
      btn.textContent = it.__installed ? "已安装" : "安装";
      acts.append(btn);
    }
    const foot = el("dsh-mcp-pfoot");
    foot.append(facts, acts);
    return foot;
  }

  function card(it, variant) {
    const root = document.createElement("div");
    root.className = "dsh-mcp-pcard " + (variant === "yi" ? "cardB" : "cardC");
    const head = el("dsh-mcp-phead");
    head.innerHTML =
      '<span class="dsh-mcp-pavatar">' + (it.name[0] || "?").toUpperCase() + "</span>" +
      '<div class="dsh-mcp-piden"><h3 class="dsh-mcp-pname" title="' + it.name + '">' + it.name + "</h3>" +
      '<div class="dsh-mcp-pmeta">' +
      (it.official ? '<span class="official"><span class="odot"></span>官方</span><span class="pdot">·</span>' : "") +
      '<span class="dsh-mcp-prepo" title="' + it.repo + '">' + it.repo + "</span></div></div>" +
      '<span class="dsh-mcp-pverified" title="已验证 · dsh ' + it.va + '">' + SEAL + "</span>";
    const desc = document.createElement("div");
    desc.className = "dsh-mcp-pdesc";
    desc.textContent = it.desc;
    const row = el("dsh-mcp-pchips" + (variant === "yi" ? " wrap" : ""));
    root.append(head, desc, row, footFor(it, variant));
    return { root, row, list: chipsFor(it, variant) };
  }

  const SECTION = [
    ["cur", "① 现状（卡高 184px）", "标签行只有分类/标签；已验证的 dsh 版本藏在头部 15px 小章的 title 里；npm 包名完全不显示；底栏一个按钮"],
    ["jia", "② 方案甲 · 卡高 0 变化（<b>已上线 2026-10-24</b>）", "徽章行第一枚 = npm 包名（仅当 ≠ 名称），用 .dsh-mcp-pchip.mono：它是全行唯一 flex:0 1 auto 的一枚，放不下只截它自己（省略号 + title 兜底），分类/标签保持 flex:none 永不裁半截；底栏「核验 MM-DD」换成「dsh 版本」，头部小章仍在，title 写完整「已验证 · dsh x.y.z-rc.w · 核验 MM-DD」；不加按钮"],
    ["jia2", "③ 方案甲+ · 甲再补「详情」按钮（底栏按钮禁止换行）", "与甲同数据，只是底栏多一枚「详情」。实测 250px 列宽下约 1% 的卡版本尾字会被硬裁（.dsh-mcp-pfacts 是 nowrap+overflow:hidden）；若不禁掉按钮换行，这些卡会掉出第二行 → 215px"],
    ["yi", "④ 方案乙 · 徽章行两行封顶（+29px）", "用技能卡同款 .dsh-mcp-badge：已验证版本 + npm 包名（超长省略号）+ 分类 + 标签全给；底栏加「详情」。代价：约一半的卡需要两行，网格同行等高 → 几乎整屏 +29px"],
  ];

  const app = document.getElementById("app");
  const measured = { cur: [], jia: [], jia2: [], yi: [] };
  for (const [variant, title, hint] of SECTION) {
    const h = document.createElement("h2");
    h.innerHTML = title + " <small>" + hint + "</small>";
    app.append(h);
    const strip = document.createElement("div");
    strip.className = "strip";
    for (const it of SAMPLES) {
      for (const cw of [250, 268]) {
        const fig = document.createElement("figure");
        fig.className = "cell";
        fig.style.cssText = "margin:0;width:" + cw + "px";
        const cap = document.createElement("figcaption");
        cap.textContent = cw + "px · " + it.name + (it.npm === it.name ? "（包名＝名称）" : "");
        const { root, row, list } = card(it, variant);
        root.style.minHeight = "0";
        fig.append(cap, root);
        strip.append(fig);
        app.append(strip);
        // 同步量：getBoundingClientRect 会强制布局，后台标签页里 rAF 不一定触发
        if (variant !== "yi") trimRow(row, list);
        else for (const n of list) row.append(n);
        measured[variant].push({
          name: it.name,
          w: cw,
          h: Math.round(root.getBoundingClientRect().height),
          chips: Math.round(row.getBoundingClientRect().height),
          foot: Math.round(root.querySelector(".dsh-mcp-pfoot").getBoundingClientRect().height),
          // 底栏左侧被硬裁（.dsh-mcp-pfacts 是 nowrap + overflow:hidden）
          clipped: (() => {
            const f = root.querySelector(".dsh-mcp-pfacts");
            return f.scrollWidth > f.clientWidth + 1 ? Math.round(f.scrollWidth - f.clientWidth) : 0;
          })(),
        });
        renderTable();
      }
    }
  }

  function renderTable() {
    const box = document.getElementById("legend");
    const KEYS = ["cur", "jia", "jia2", "yi"];
    const LABEL = { cur: "现状", jia: "方案甲", jia2: "方案甲+", yi: "方案乙" };
    if (KEYS.some((k) => !measured[k].length)) return;
    const max = (v) => Math.max(...measured[v].map((m) => m.h));
    const mn = (v) => Math.min(...measured[v].map((m) => m.h));
    const cells = (fn) => KEYS.map((k) => "<td>" + fn(k) + "px</td>").join("");
    box.innerHTML =
      "<b>看什么：</b>同一批真实条目（超长作用域包名、宿主组件、0 Star、包名＝名称各一条）在 250px / 268px 两种列宽下的表现，CSS 与 DOM 结构逐字照现网。" +
      "<table><thead><tr><th>台架现量</th>" + KEYS.map((k) => "<th>" + LABEL[k] + "</th>").join("") + "</tr></thead><tbody>" +
      "<tr><th>本批最高卡（网格按行等高 = 屏上行高）</th>" + cells(max) + "</tr>" +
      "<tr><th>本批最矮卡</th>" + cells(mn) + "</tr>" +
      "<tr><th>徽章行高</th>" + cells((k) => Math.max(...measured[k].map((m) => m.chips))) + "</tr>" +
      "<tr><th>底栏行高（按钮掉到第二行 = 78）</th>" + cells((k) => Math.max(...measured[k].map((m) => m.foot))) + "</tr>" +
      "<tr><th>底栏左侧被硬裁的卡（裁掉多少 px）</th>" +
      KEYS.map((k) => {
        const bad = measured[k].filter((m) => m.clipped);
        return "<td>" + (bad.length ? bad.length + " 张 · 最多 " + Math.max(...bad.map((m) => m.clipped)) + "px" : "0 张") + "</td>";
      }).join("") +
      "</tr>" +
      "</tbody></table>";
  }
  renderTable();

  // ── 全量目录分布（.card-measure.mjs 对 6430 条真实条目逐条排布模拟，非抽样）──
  const STATS = [
    ["卡面自然高度", "184px", "184px（0 变化）", "184px（0 变化）", "213px（+29px，+15.8%）"],
    ["已验证的 dsh 版本<br><small>6430 条全有值，现在只活在头部 15px 章的 title 里</small>", "不显示", "底栏直接写「dsh 0.2.0-rc.2」", "同甲", "徽章行第一枚直接写"],
    ["npm 包名<br><small>2717 条 ≠ 显示名（42.3%）</small>", "不显示", "<b>已上线</b>：标签行第一枚 mono 芯片，全行只允它一枚收缩 → 2717 条 100% 出现；内容宽 224 下 1413 条（52.0%）省略号截断、244 下 986（36.3%）、316 下 139（5.1%），最窄仍有 21px 可见，完整包名进 title", "同甲", "100% 显示，33 条以省略号截断"],
    ["分类<br><small>只有 67 条 ≠ plugin</small>", "已显示", "不变", "不变", "不变"],
    ["标签<br><small>每条 1–2 个，不存在 3 个以上</small>", "全部显示（现状这行从不裁切）", "<b>一枚没丢</b>：9898 枚分类/标签芯片 0 张被裁半截，全量只有 8 张卡出现 +N（收缩代价全在包名那枚）", "同甲", "全给，但 16.4% 的卡第三行被裁（不做 +N 折叠时 21%）"],
    ["底栏「详情」按钮", "无", "无", "有（250px 列宽下 1.1% 的卡版本尾字被硬裁；268px 列宽 0%）", "有（0% 裁切：文案沿用现状，max 218px ≤ 224px）"],
    ["需要两行的卡", "0%", "0%（永不换行）", "0%", "52.9% @224 ｜ 42.1% @244 ｜ 24.1% @316"],
    ["网格同行的后果<br><small>grid 同行等高：一行里只要有一张两行卡，整行被抬高</small>", "每行 184px", "每行 184px", "每行 184px", "94.6% 的行被拉到 213px → 同屏少看约 1/7 行"],
  ];
  const box = document.createElement("div");
  box.className = "box";
  box.style.marginTop = "26px";
  box.innerHTML =
    "<b>逐条实测（6430 条目录，非抽样）</b>　列宽换算：250px 卡 → 内容 224px，268px 卡 → 内容 244px，340px 卡 → 内容 316px（grid auto-fill minmax(250px,1fr)）。" +
    "<table><thead><tr><th>信息位</th><th>现状</th><th>方案甲</th><th>方案甲+</th><th>方案乙</th></tr></thead><tbody>" +
    STATS.map((r) => "<tr>" + r.map((c, i) => (i ? "<td>" : "<th>") + c + (i ? "</td>" : "</th>")).join("") + "</tr>").join("") +
    "</tbody></table>" +
    "<p class='note' style='margin-top:10px'>已经量掉、不建议再试的四种写法：<br>" +
    "① <b>版本芯片放头部第三列</b>——第三列从 16px 涨到 74px，标题列从 158px 缩到 110px，名称截断率 26.4%→69.9%、仓库行 32.7%→87.1%，得不偿失。<br>" +
    "② <b>底栏同时保留「核验日期 + 版本」</b>——max 271.9px > 224px，13.4% 的卡尾字被裁；只能二选一。<br>" +
    "③ <b>补「下载量 / 安装量」</b>——slim.json 每条只有 11 个字段，没有任何下载与安装计数，技能卡那几个数字是 SkillHub 自己给的，插件目录给不出，不能编。<br>" +
    "④ <b>每卡拉 GitHub 补「最近提交 / issue 数」</b>——未认证配额 60 次/小时，一页 12 张卡就见底；「维护动态」继续只在详情里按需拉。<br>" +
    "⑤ <b>描述行 height:38px 改 min-height:38px</b>——全量只有 45/6430（0.7%）是单行描述，改了不给信息，只把卡变得参差，不动。<br>" +
    "⑥ <b>包名与显示名重复的那 1116 条要不要干脆不显示</b>——2717 条 ≠ 名称的条目里有 1116 条包名包含显示名（其中 916 条只是加了 npm scope）。但 scope 是安装命令的一部分（<code>npm i @huanlin/x</code> 与 <code>x</code> 不是同一个包），去掉就把最有用的那截丢了，所以仍然整枚显示、由它自己承担省略号。</p>";
  document.getElementById("app").append(box);
})();
