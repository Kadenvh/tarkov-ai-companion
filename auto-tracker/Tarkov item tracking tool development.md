## Tarkov item tracking tool development

Last updated: 2026-07-11

\---

### *User:*

Escape from Tarkov just released 1.0 \& i'm playing it again. Given my previus 8 months in the AI \& Computer Science space I want to work on finding and/or creating some better internal and/or external tools. The go-to for most is the TarkovTracker (https://tarkovtracker.io) which includes a lot of helpful tools \& insights, like Tarkov.dev, Rat Scanner (https://ratscanner.com), Tarkov Guru (https://tarkov.guru),  Tarkov Changes (https://tarkov-changes.com), as well as an available API key used with tools like RatScanner \& Tarkov.dev. These tools are nice, but given the large content (mostly items) it can be hard to manually track items; items can be used for many different things but we'll mainly want to focus on Hideout \& Quest / Task items. As a seasoned tarkov player I generally know what I need \& what I don't, but it'd be nice if some of the memory load were removed. RatScanner is the closest existing 'product' that fits the criteria, but it's applications don't necessarily match my wants // needs. I found a github repository (https://github.com/the-hideout/tarkov-api) that I haven't taken a look at (I also found https://forge.sp-tarkov.com/mod/898/kmy-tarkov-api but it may just be for SPT) that may be promising. Can you research this topic \& help me either find or curate a solution?



### *Claude:*

I'll research the Tarkov API ecosystem and existing tools to help you build something tailored to your needs. Let me dive into this.

Alright, let me break down the ecosystem and architect a solution that fits your automation/AI skillset.

## **The Current Landscape**

**What Exists:**

* **Tarkov GraphQL API** (api.tarkov.dev) - Free, comprehensive, real-time data on everything: quests, hideout requirements, items, barters, crafts
* **TarkovTracker API** - Personal progress tracking with read/write tokens
* **TarkovMonitor** - Log file parser that auto-updates TarkovTracker quest progress
* **RatScanner** - OCR-based item scanner (C# .NET, open source) - scans items for pricing but doesn't check if YOU need it

**The Gap You're Hitting:**
None of these tools cross-reference "item in hand" with "your specific quest/hideout needs." RatScanner says "worth 50k," but you need "Keep for Hideout Level 2 Workbench" or "Needed for 3 different Prapor quests."

\---

## **Solution Architecture**

Given your background (Python, n8n, React, automation), here are three paths:

### **Option 1: Quick Python Script (2-4 hours)**

Build a local CLI/TUI tool that:

* Fetches your TarkovTracker progress via API
* Cross-references with Tarkov GraphQL API for hideout/quest requirements
* Takes item name as input → outputs "Keep/Sell" recommendation with reasoning

**Tech Stack:**

* Python + `requests` for API calls
* `rich` or `textual` for TUI
* Local caching to avoid rate limits

**Pros:** Fast to build, runs anywhere, no dependencies
**Cons:** Manual item lookup (you type item names)

\---

### **Option 2: Enhanced RatScanner Fork (1-2 weeks)**

Fork RatScanner and add a "Smart Recommendations" layer:

* Keep the OCR scanning functionality
* Add TarkovTracker API integration for YOUR progress
* When you scan an item, show: price + "Keep for X quests" or "Sell - not needed"

**Tech Stack:**

* C# .NET (RatScanner's stack)
* GraphQL queries to api.tarkov.dev
* TarkovTracker API integration

**Pros:** Leverages proven OCR, minimal new work, visual overlay
**Cons:** C# learning curve if you're not familiar

\---

### **Option 3: Full Custom Tool (2-4 weeks)**

Build an Overwolf app or Electron desktop app:

* React frontend (you know this)
* Integrates TarkovMonitor's log reading for auto-detection
* Real-time item tracking with smart recommendations
* Could eventually become your "Across The Obelisk tracker" equivalent for Tarkov

**Tech Stack:**

* React + Electron or Overwolf SDK
* Python backend for log parsing (or port TarkovMonitor's C# logic)
* GraphQL + TarkovTracker APIs
* Could use n8n for data pipelines if needed

**Pros:** Full control, potential for community tool, portfolio piece
**Cons:** Time investment, ongoing maintenance

\---

## **Recommended Approach: Start with Option 1, Evolve to Option 2**

**Phase 1: Python CLI (This Weekend)**

1. Get TarkovTracker API token from your account
2. Build Python script that:

   * Queries your incomplete quests/hideout needs
   * Creates a "needed items" database
   * Takes item name → outputs recommendation
3. Run it in terminal while playing, manual lookups

**Phase 2: Auto-Detection (Next Week)**
4. Add clipboard monitoring or OCR (using `pytesseract` + screenshot hotkey)
5. Or integrate with TarkovMonitor's log reading approach
6. Auto-scan items when you hover/inspect them

**Phase 3: Visual Overlay (Later)**
7. Port to Electron or fork RatScanner
8. Add visual overlay with your recommendation system

\---

## **Implementation Checklist**

### **Immediate Actions:**

* \[ ] Create TarkovTracker account and generate API token (read/write permissions)
* \[ ] Test Tarkov GraphQL API playground at https://api.tarkov.dev/
* \[ ] Clone the tarkov-api repo for GraphQL examples
* \[ ] Review TarkovMonitor's log parsing code (C#) to understand item detection

### **Quick Win Script Structure:**

```python
# pseudocode
import requests

# 1. Fetch your quest/hideout data from TarkovTracker API
my\_progress = get\_tarkov\_tracker\_progress(api\_token)

# 2. Query Tarkov GraphQL API for all quest/hideout requirements
all\_requirements = query\_tarkov\_graphql\_api()

# 3. Build "items\_i\_need" dictionary
items\_needed = calculate\_needed\_items(my\_progress, all\_requirements)

# 4. Lookup function
def check\_item(item\_name):
    if item\_name in items\_needed:
        return f"KEEP: Needed for {items\_needed\[item\_name]}"
    else:
        return "SELL: Not needed for quests/hideout"
```

### **APIs You'll Use:**

* **Tarkov GraphQL API:** https://api.tarkov.dev/\_\_\_graphql
* **TarkovTracker API:** https://tarkovtracker.io/settings (create token)
* **GraphQL Examples:** https://github.com/the-hideout/tarkov-api/blob/main/docs/graphql-examples.md

\---

## **Key Technical Insights**

**From the GraphQL API:**

* Query `tasks` for quest requirements with `taskRequirements.items`
* Query `hideoutStations` for upgrade requirements with `levels.itemRequirements`
* Both return BSG item IDs + quantities needed

**From TarkovTracker API:**

* `GET /api/v2/progress` returns your completed/incomplete tasks
* `GET /api/v2/hideout/progress` returns your hideout status
* Cross-reference with GraphQL to calculate what you still need

**Smart Recommendations Logic:**

```python
# Priority scoring
if item\_needed\_for\_locked\_quest\_soon:
    priority = "HIGH"
elif item\_needed\_for\_hideout\_upgrade\_ready:
    priority = "MEDIUM"
elif item\_needed\_later\_in\_wipe:
    priority = "LOW"
else:
    priority = "SELL"
```

\---

## **Next Steps**

**Right Now:**

1. Go to TarkovTracker → Settings → Create API Token
2. Test a GraphQL query in the playground (try fetching all quests)
3. Decide: Do you want Option 1 (CLI script) or jump straight to Option 2 (RatScanner fork)?

**If You Choose Option 1 (CLI):**
I can generate the Python script structure with API integration examples right now. We can have a working prototype in one conversation.

**If You Choose Option 2 (RatScanner Fork):**
I can help you understand the C# codebase and map out where to inject the TarkovTracker API logic.

**If You Choose Option 3 (Full Custom Tool):**
We can architect the full system with React frontend + Python backend, leveraging your n8n skills for data pipelines.

Which path appeals most? I'm betting Option 1 to test the concept, then evolve to Option 2 once proven.



### *User:*

I didn't read your response, but I think the best solution would be that when I get out of raid, I move any items we need to track to the sorting table. Either an image could be parsed \& an actual script, but regardless everything I grab and/or extract with won't need to be tracked. What was the approach you intended on taking?



### *Claude:*

# Your Approach is Better

**My Plan:** In-raid scanning (RatScanner style) with manual lookups  
**Your Plan:** Sorting table batch processing post-raid ← **This is smarter**

\---

## **Why Sorting Table is Superior**

✅ **Fixed UI layout** = reliable OCR coordinates  
✅ **Batch processing** = one action handles everything  
✅ **No raid pressure** = take your time  
✅ **Clear intent** = "I moved it here, so I care about it"

\---

## **Implementation Path**

### **Option A: Screenshot → OCR → Lookup (Python)**

**Flow:**

1. Press hotkey → screenshot sorting table
2. OCR extracts all item names
3. Cross-reference with TarkovTracker progress
4. Output: "Keep 3, Sell 5" with reasons

**Tech:**

* Python + `pytesseract` for OCR
* `PIL` for screenshot capture
* Tarkov GraphQL API + TarkovTracker API
* Hotkey listener (`pynput` or `keyboard`)

**Time:** 4-8 hours

\---

### **Option B: Memory Reading (Advanced)**

**Flow:**

1. Read game memory for sorting table contents
2. Direct item ID lookup (no OCR needed)
3. Instant recommendations

**Tech:**

* C# or Python + memory reading library
* More reliable but BSG gray area

**Time:** 2-3 days  
**Risk:** Potential ToS concerns

\---

### **Option C: Log File Parsing (Safest)**

**Flow:**

1. Monitor game logs for "ItemMovedEvent"
2. Track items moved to sorting table
3. Build list, cross-reference needs

**Tech:**

* Python log monitoring
* TarkovMonitor uses this approach
* 100% external, zero ban risk

**Time:** 6-10 hours

\---

## **Recommended: Hybrid Approach**

**Phase 1: OCR Prototype** (This weekend)

```python
# Hotkey pressed
screenshot\_sorting\_table()
items = ocr\_extract\_items(screenshot)
recommendations = check\_against\_needs(items)
display\_overlay(recommendations)
```

**Phase 2: Add Log Monitoring** (Next week)

* Passive tracking without screenshots
* Auto-detect when items hit sorting table

\---

## **What I Need to Build This**

1. **Your screen resolution** (for OCR coordinates)
2. **TarkovTracker API token** (create at tarkovtracker.io/settings)
3. **Preference: Screenshot OCR or Log Parsing?**

**Next Action:** Which option? I'll generate the starter code.



### *User:*

This approach would also allow me to bulksort items, ie in a junk box, and then upload that image (I wouldn't have to take a screenshot or run a program after each raid; it would be up to me. Would we be able to use the API key from tarkov tracker? ie be able to store all the data on that website, which in turn would also allow us to utilize in-raid rat scanner? Parsing an image \& utilizing the API would be a very simple \& effecctive approach, which I think sounds good.



### *Claude:*

# YES - This is Actually Perfect

## **The Ecosystem Loop**

```
Upload Image → OCR Items → Update TarkovTracker API → RatScanner Reads Your Progress
     ↑                                                              ↓
     └──────────────── Continuous feedback loop ────────────────────┘
```

\---

## **TarkovTracker API = Your Central Database**

✅ **Read/Write Token** allows:

* Marking items as "found/in stash"
* Updating quest progress
* Tracking hideout upgrades

✅ **RatScanner Integration:**

* Already supports TarkovTracker API
* Will read YOUR progress to give personalized recommendations
* "Keep for Hideout Level 3" instead of just "20k rubles"

\---

## **Implementation Plan**

### **Tool Structure**

**Input:** Image (screenshot or upload)  
**Process:** OCR → Item extraction → TarkovTracker update  
**Output:** Updated progress + recommendations

### **Tech Stack**

* **Python** for backend processing
* **pytesseract** or **EasyOCR** for item recognition
* **TarkovTracker API** for progress storage
* **Tarkov GraphQL API** for item ID matching
* \*\*Simple



### *User:*

This approach would also allow me to bulksort items, ie in a junk box, and then upload that image (I wouldn't have to take a screenshot or run a program after each raid; it would be up to me. Would we be able to use the API key from tarkov tracker? ie be able to store all the data on that website, which in turn would also allow us to utilize in-raid rat scanner? Parsing an image \& utilizing the API would be a very simple \& effecctive approach, which I think sounds good. I also have n8n, so a simple image upload and/or file update trigger (ie I store all the 'images' in a folder, or more so add them to the folder, \& it detects // uploads // parses // \& sends an API request (assuming we can accomplish this) would work beautifully.



### *Claude:*

# Perfect - n8n + Bulk Image Processing + TarkovTracker API

This is **way smarter** than my in-raid approach. Let's build it.

\---

## **System Architecture**

```
Image Folder → n8n Workflow → OCR Service → TarkovTracker API Update
     ↓
RatScanner reads TarkovTracker → In-raid recommendations
```

\---

## **Critical API Question**

**TarkovTracker API Capabilities:**

* ✅ **Read** quest/hideout progress
* ✅ **Write** quest/hideout completion status
* ❌ **No inventory tracking endpoint** (currently)

**Problem:** TarkovTracker doesn't have an "items I own" endpoint. It only tracks quest/hideout *completion*, not *inventory*.

\---

## **Solution: Two-Tier Approach**

### **Tier 1: Local Database (Your Source of Truth)**

* n8n workflow populates **your own database** (Supabase, SQLite, or even Google Sheets)
* Store: `{item\_name, quantity, timestamp, needs: \[quests, hideout]}`

### **Tier 2: TarkovTracker for Quest Progress**

* Use TarkovTracker API to track *what you need*
* Cross-reference with Tier 1 to know *what you have*

\---

## **n8n Workflow Design**

### **Trigger:** File Added to Folder

```
Watch Folder: \~/tarkov-screenshots/
```

### **Step 1: OCR Processing**

**Option A - Python HTTP Service** (Recommended)

```python
# FastAPI endpoint you host locally
@app.post("/ocr")
def process\_tarkov\_image(image: UploadFile):
    items = extract\_items\_from\_sorting\_table(image)
    return {"items": items}
```

**Option B - Cloud OCR**

* Google Vision API
* AWS Textract
* Both work in n8n via HTTP nodes

### **Step 2: GraphQL Query (Tarkov API)**

```graphql
query GetItemDetails($names: \[String!]!) {
  items(name: $names) {
    id
    name
    shortName
    avg24hPrice
    usedInTasks {
      name
      trader { name }
    }
    usedInHideoutStation {
      level
      station { name }
    }
  }
}
```

### **Step 3: Cross-Reference TarkovTracker**

```
HTTP Request Node:
GET https://tarkovtracker.io/api/v2/progress
Headers: Authorization: Bearer YOUR\_API\_TOKEN

Response: {incomplete quests, hideout stations}
```

### **Step 4: Store Results**

**Supabase Table Schema:**

```sql
CREATE TABLE tarkov\_inventory (
  id SERIAL PRIMARY KEY,
  item\_name TEXT,
  quantity INT,
  avg\_price DECIMAL,
  needed\_for JSONB,  -- {quests: \[], hideout: \[]}
  keep\_decision TEXT,  -- 'KEEP\_QUEST', 'KEEP\_HIDEOUT', 'SELL'
  scanned\_at TIMESTAMP
);
```

### **Step 5: Output Notification**

* Telegram message
* Discord webhook
* Google Sheets row
* Whatever you prefer

\---

## **RatScanner Integration**

**Problem:** RatScanner can't read your custom database directly.

**Solution Options:**

### **Option A: Fork RatScanner**

Add HTTP call to your n8n webhook:

```csharp
// When item scanned
var response = await httpClient.GetAsync(
    $"http://localhost:5678/webhook/check-item?name={itemName}"
);
```

### **Option B: Browser Extension Companion**

* Small Chrome extension
* Runs on tarkov.dev or TarkovTracker site
* Shows "You have 3x in stash" overlay
* No need to modify RatScanner

### **Option C: Accept RatScanner Limitation**

* Use RatScanner for pricing only
* Use your n8n dashboard for "do I need this?" checks

\---

## **Implementation Checklist**

### **Phase 1: OCR Service (Today)**

* \[ ] Build Python FastAPI OCR endpoint
* \[ ] Test with sorting table screenshot
* \[ ] Verify item name extraction accuracy

### **Phase 2: n8n Workflow (Tomorrow)**

* \[ ] File watcher trigger
* \[ ] HTTP call to OCR service
* \[ ] GraphQL query to Tarkov API
* \[ ] TarkovTracker API integration
* \[ ] Store results (Supabase or Sheets)

### **Phase 3: Dashboard (This Week)**

* \[ ] Simple React page showing inventory
* \[ ] "Keep/Sell" recommendations
* \[ ] Filter by quest/hideout needs

### **Phase 4: RatScanner Bridge (Optional)**

* \[ ] Fork RatScanner repo
* \[ ] Add webhook call to your n8n instance
* \[ ] Display custom recommendations

\---

## **Quick Start: MVP in 2 Hours**

### **What You Need:**

1. **OCR Service** - I'll give you Python FastAPI code
2. **n8n Workflow** - I'll give you JSON template
3. **TarkovTracker API Token** - Get from tarkovtracker.io/settings
4. **Supabase Project** - Free tier (or use Google Sheets)

### **MVP Flow:**

```
Drop screenshot → n8n detects → OCR extracts items → 
Stores in Sheets → Sends you Discord message with recommendations
```

\---

## **Code Generation Options**

**I can build RIGHT NOW:**

### **A. Python OCR Service**

FastAPI endpoint that takes image → returns item names

### **B. n8n Workflow JSON**

Import-ready workflow template

### **C. Supabase Schema + Functions**

Database setup + edge functions for logic

### **D. React Dashboard**

Simple inventory viewer with keep/sell logic

\---

## **Critical Decision Point**

**Where do you want to store inventory data?**

1. **Supabase** (your existing stack, Edge Functions)
2. **Google Sheets** (quick, visual, no code)
3. **SQLite file** (local, simple, fast)

**My Recommendation:** Google Sheets for MVP (1-2 hours), migrate to Supabase when proven (4-6 hours).

\---

## **Immediate Next Action**

**Tell me:**

1. Storage preference (Sheets/Supabase/SQLite)
2. Want the Python OCR code now?
3. Want the n8n workflow JSON now?

I'll generate working code immediately.



### *User:*

What did you find in relation to the github repository i mentioned initially?



### *Claude:*

# The GitHub Repository Analysis

## **the-hideout/tarkov-api**

This is the **official GraphQL API** that powers tarkov.dev, TarkovTracker, and most community tools.

### **What I Found:**

**It's Production-Ready Infrastructure:**

* Free, open-source GraphQL API
* Runs on Cloudflare Workers (ultra-fast edge compute)
* Real-time data updates
* Powers tarkov.dev, RatScanner's backend, and other major tools

**Available Data:**

* ✅ All items with prices, stats, icons
* ✅ Quest requirements and objectives
* ✅ Hideout station requirements
* ✅ Barter trades and crafts
* ✅ Ammo/armor stats
* ✅ Boss locations
* ✅ Flea market data

**GraphQL Playground:**

* Live testing at https://api.tarkov.dev/
* No API key required for read operations
* Rate limits exist but generous

**Example Query for Your Use Case:**

```graphql
query GetQuestAndHideoutItems {
  tasks {
    name
    trader { name }
    objectives {
      ... on TaskObjectiveItem {
        item { name id }
        count
        foundInRaid
      }
    }
  }
  
  hideoutStations {
    name
    levels {
      level
      itemRequirements {
        item { name id }
        count
      }
    }
  }
}
```

\---

## **The SPT API You Mentioned**

**Repository:** https://forge.sp-tarkov.com/mod/898/kmy-tarkov-api

This is **completely different**:

* For **SPT-AKI** (Single Player Tarkov mod)
* Server-side mod for offline play
* Not relevant for live Tarkov

**Verdict:** Ignore this one for your project.

\---

## **How This Fits Your Solution**

### **Perfect for Your n8n Workflow:**

**Step 1: OCR extracts item names from screenshot**

```
\["Bolts", "Corrugated Hose", "Military Cable"]
```

**Step 2: Query tarkov-api GraphQL**

```graphql
query CheckItems($names: \[String!]!) {
  items(name: $names) {
    name
    avg24hPrice
    usedInTasks {
      name
      trader { name }
    }
    usedInHideoutStation {
      level
      station { name }
    }
  }
}
```

**Step 3: Get response like:**

```json
{
  "name": "Bolts",
  "avg24hPrice": 15234,
  "usedInTasks": \[
    {"name": "Gunsmith Part 1", "trader": {"name": "Mechanic"}}
  ],
  "usedInHideoutStation": \[
    {"level": 2, "station": {"name": "Workbench"}}
  ]
}
```

**Step 4: Decision logic in n8n:**

```javascript
// In n8n Function node
if (item.usedInTasks.length > 0 || item.usedInHideoutStation.length > 0) {
  return { decision: 'KEEP', reason: item.usedInTasks\[0].name };
} else {
  return { decision: 'SELL', value: item.avg24hPrice };
}
```

\---

## **Key Insight: You Don't Need TarkovTracker API for Basic Version**

**Simplified Architecture:**

```
Screenshot → OCR → tarkov-api GraphQL → Decision
```

**Without TarkovTracker:**

* Shows ALL quest/hideout uses
* Doesn't know YOUR progress
* Recommendation: "Needed for X quests"

**With TarkovTracker API:**

* Filters to incomplete quests only
* Knows which hideout stations you built
* Recommendation: "Needed for 2 incomplete quests"

\---

## **Revised Implementation Plan**

### **Phase 1: Basic (No TarkovTracker)**

```
n8n Workflow:
1. File trigger → Image uploaded
2. HTTP → Call OCR service
3. HTTP → Query tarkov-api GraphQL
4. Function → Decide keep/sell
5. Google Sheets → Store results
```

**Time:** 2-3 hours  
**Accuracy:** "This item is used in quests" (not personalized)

### **Phase 2: Personalized (Add TarkovTracker)**

```
n8n Workflow (additional step):
4a. HTTP → Get YOUR progress from TarkovTracker
4b. Function → Filter to incomplete only
```

**Time:** +1 hour  
**Accuracy:** "You need this for 2 incomplete quests"

\---

## **What You Can Build RIGHT NOW**

Since `the-hideout/tarkov-api` is **fully public and free**, you can:

1. **Test queries immediately** at https://api.tarkov.dev/\_\_\_graphql
2. **Build n8n workflow** with just HTTP Request nodes (no auth needed)
3. **Skip TarkovTracker integration** for MVP

\---

## **Next Steps**

**Option A: Test the API First**

* Go to https://api.tarkov.dev/\_\_\_graphql
* Run the query I provided above
* See what data you get

**Option B: Build MVP Immediately**

* I'll generate the n8n workflow JSON
* You import it and test with a screenshot
* Working prototype in 30 minutes

**Which path?** Or do you want me to generate both the test query AND the n8n workflow now?





\---

*This document was created using **Claudify⚡** – Your smart solution for turning chats into PDFs.* [*Download Claudify now*](https://chromewebstore.google.com/detail/hofibnjfkkmlhnpjegcekcnnpnpjkgdj) *to preserve and organize your conversations effortlessly!*

