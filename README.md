# 🎬 我的影音收藏館

我的個人 YouTube 影片資料庫。依照我喜歡的類型自動整理影片，**每兩天自動更新一次**，也可以收藏影片、建立收藏夾，手機和電腦同步。

- 類型一 🗾 **日本**：鐵道、日本職棒、City Pop 1980、J-POP、1990–2010 日劇歌曲
- 類型二 📻 **我的興趣**：收音機、按鍵手機、網路收音機、廣播、短波、懷舊台灣、昭和懷舊浪漫、台灣歷史、台灣日治時期
- 之後可以在網頁的「分類管理」新增類型三、類型四……

---

## 📦 檔案說明

| 檔案 | 用途 |
|---|---|
| `index.html`、`app.js`、`style.css` | 網頁本體 |
| `config/categories.json` | **分類設定**（類型、關鍵字、追蹤頻道）。可在網頁「分類管理」修改 |
| `data/videos.json` | 自動抓到的影片（程式產生，不用手動改） |
| `data/favorites.json` | 我的最愛＋收藏夾 |
| `data/channels_cache.json` | 頻道 ID 快取（程式產生） |
| `scripts/fetch.py` | 抓影片的程式 |
| `.github/workflows/update.yml` | 每兩天自動執行的排程 |

---

## 🚀 第一次設定（約 20 分鐘，只要做一次）

### 步驟 1：建立 GitHub repo 並上傳檔案

1. 登入 GitHub，右上角 **＋ → New repository**
2. Repository name 填 `youtube-library`，選 **Public**（GitHub Pages 免費版需要公開），按 **Create repository**
3. 在新 repo 頁面按 **uploading an existing file**，把解壓縮後資料夾裡的**所有檔案和資料夾**拖進去，按 **Commit changes**

> ⚠️ **注意 `.github` 資料夾**：它是「隱藏資料夾」，Mac 的 Finder 預設看不到（按 `Cmd + Shift + .` 可顯示），拖拉時可能漏掉。
> 上傳後請確認 repo 裡有 `.github/workflows/update.yml`。如果沒有：
> 按 **Add file → Create new file**，檔名輸入 `.github/workflows/update.yml`，把壓縮檔中同名檔案的內容貼上，按 **Commit changes**。

### 步驟 2：申請 YouTube API Key（免費）

1. 打開 <https://console.cloud.google.com/>，用 Google 帳號登入
2. 上方選單 **選取專案 → 新增專案**，名稱填 `youtube-library`，按 **建立**
3. 左上 ☰ → **API 和服務 → 程式庫**，搜尋 **YouTube Data API v3** → 點進去 → **啟用**
4. 左側 **憑證 → ＋建立憑證 → API 金鑰**，複製產生的金鑰（`AIza` 開頭）
5. （建議）點 **編輯 API 金鑰 → API 限制 → 限制金鑰**，只勾 **YouTube Data API v3** → 儲存

> 💡 免費額度每天 10,000 單位。本網站每次更新約用 3,000–5,500（第一次較多，因為要找頻道），完全足夠，不會收費。

### 步驟 3：把 API Key 放進 GitHub（不會公開）

1. 在 repo 頁面 **Settings → Secrets and variables → Actions**
2. 按 **New repository secret**
3. Name 填 `YOUTUBE_API_KEY`，Secret 貼上步驟 2 的金鑰，按 **Add secret**

### 步驟 4：允許自動更新寫入資料

**Settings → Actions → General**，最下面 **Workflow permissions** 選 **Read and write permissions** → **Save**

### 步驟 5：開啟網站（GitHub Pages）

**Settings → Pages**，Source 選 **Deploy from a branch**，Branch 選 **main**、資料夾 **/(root)** → **Save**。
約 1 分鐘後，網址會是：`https://你的帳號.github.io/youtube-library/`

### 步驟 6：第一次抓影片

**Actions** 分頁 → 左側 **自動更新影片** → 右側 **Run workflow** → **Run workflow**。
約 1–3 分鐘後出現綠色 ✓，重新整理網站就有影片了。之後每兩天早上 6 點會自動更新。

### 步驟 7：建立 Token，讓收藏可以同步（手機、電腦都能用）

1. GitHub 右上角頭像 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. Token name：`youtube-library`；Expiration：選最長（到期前 GitHub 會寄信提醒，再重新產生一個即可）
3. **Repository access** 選 **Only select repositories** → 選 `youtube-library`
4. **Permissions → Repository permissions**：
   - **Contents** → **Read and write**（存收藏、改分類）
   - **Actions** → **Read and write**（網頁上的「立即更新」按鈕）
5. 按 **Generate token**，複製（`github_pat_` 開頭，只會顯示一次）
6. 打開網站 → 右上 **⚙️ 設定** → 填入 GitHub 帳號、Repo 名稱、Token → **儲存並測試**

每台裝置（電腦、iPhone）第一次打開時各輸入一次即可。Token 只存在該裝置的瀏覽器裡，不會上傳。

---

## 🧭 日常使用

| 想做的事 | 怎麼做 |
|---|---|
| 看影片 | 點縮圖，在網頁內播放 |
| 加入最愛 | 按 ♡ |
| 存到收藏夾 | 按 📁，可勾選多個收藏夾或建立新的 |
| 收藏夾加備註 | 進入收藏夾，在影片上按 ✎ |
| 收藏 YouTube 上任何影片 | 收藏夾頁面 →「貼上 YouTube 連結」 |
| 標記已看 | 按 ✓（點播放也會自動標記），可勾「隱藏已看」 |
| 新增類型／分類 | 側欄最下方「＋ 新增／管理分類」 |
| 馬上更新 | ⚙️ 設定 →「立即更新影片」 |
| 檢查頻道有沒有抓對 | ⚙️ 設定 → 影片更新狀態表格 |

---

## 🛠 調整分類與頻道

在網頁「分類管理」或直接編輯 `config/categories.json`。每個分類可以設定：

- **關鍵字**：日文主題用日文搜尋效果最好。每個關鍵字每次更新耗 100 配額，總數建議不超過 50 個
- **追蹤頻道**：一行一個，三種寫法
  - `西園寺`（用名稱搜尋，第一次會自動找頻道）
  - `西園寺 | @handle`（最準確：到頻道頁網址列複製 `@` 開頭的名稱）
  - `西園寺 | UCxxxxxxxxxxxxxxxxxxxxxx`（頻道 ID）
- **最近幾天**：職棒、J-POP 適合只看近期；懷舊、歷史類填 0（不限時間）
- **排除字詞**：標題含這些字就不收

> 若設定頁顯示某頻道抓錯了（括號裡的名稱不對），把那一行改成 `名稱 | @正確的handle` 即可。

---

## ❓ 常見問題

- **影片顯示「無法播放」**：有些上傳者（特別是唱片公司）不允許在其他網站播放，請按「在 YouTube 開啟」。
- **收藏別人看得到嗎？** repo 是公開的，所以 `favorites.json` 技術上任何人都可以看到（但一般人不會知道網址）。不要在備註寫私人資訊。
- **自動更新停了**：GitHub 規定 repo 60 天沒有任何更新會暫停排程。本網站每次更新都會產生新紀錄，正常不會停；若真的停了，到 Actions 分頁按 **Enable workflow**。
- **配額用完**：程式會保留既有影片，隔天配額恢復後下次排程會自動補上。
- **更換 API Key**：到 Settings → Secrets 修改 `YOUTUBE_API_KEY` 即可。
