import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, Check, Trophy, ExternalLink, RotateCcw, Sparkles, AlertTriangle, X, Info, ChevronsUpDown } from 'lucide-react';

const DECISIONS = {
  falling_skies_case: { id: 'falling_skies_case', chapter: 'falling_skies', taskId: 13, q: 'What did you do with the armored case?',
    opts: [{ id: 'give_prapor', label: 'Gave to Prapor', icon: '📦', d: '+1M₽ reward' }, { id: 'keep_case', label: 'Kept it', icon: '🔒', d: 'Faster unlock' }]
  },
  ticket_kerman: { id: 'ticket_kerman', chapter: 'the_ticket', taskId: 2, q: 'Work with Mr. Kerman?',
    opts: [{ id: 'yes', label: 'Yes, work with him', icon: '🤝', d: 'Opens Savior path' }, { id: 'no', label: 'No, reject', icon: '🚫', d: 'Survivor only' }]
  },
  ticket_evidence: { id: 'ticket_evidence', chapter: 'the_ticket', taskId: 5, q: 'Gather evidence for Kerman?',
    opts: [{ id: 'yes', label: 'Yes, gather it', icon: '📋', d: 'Savior ending' }, { id: 'no', label: 'No, refuse', icon: '❌', d: 'Betray Kerman' }]
  },
  ticket_final: { id: 'ticket_final', chapter: 'the_ticket', taskId: 11, q: 'Final escape route?',
    opts: [{ id: 'prapor', label: 'Prapor (500M₽)', icon: '🎖️', d: 'Fallen ending' }, { id: 'lk', label: 'Lightkeeper', icon: '🔦', d: 'Debtor ending' }]
  }
};

const ENDINGS = {
  savior: { name: 'Savior', sub: 'For Humanity', icon: '🌟', clr: 'amber', desc: 'True ending. Expose TerraGroup, save others.' },
  survivor: { name: 'Survivor', sub: 'Selfish Escape', icon: '🏃', clr: 'slate', desc: 'Escape alone. TerraGroup nukes Tarkov.' },
  fallen: { name: 'Fallen', sub: 'Betrayer', icon: '💀', clr: 'red', desc: 'Betrayed Kerman. Paid 500M₽ to Prapor.' },
  debtor: { name: 'Debtor', sub: "LK's Pawn", icon: '⛓️', clr: 'purple', desc: 'Owe Lightkeeper. New prison.' }
};

const CH = {
  tour: { name: 'Tour', icon: '🗺️', clr: 'emerald', tasks: [
    {t:'Escape Ground Zero',h:'Complete tutorial raid behind SkySide building'},
    {t:'Talk to Therapist',h:'Visit Therapist in Traders menu'},
    {t:'Pay 250K₽',h:'Hand over 250,000 Roubles for Streets access'},
    {t:'Talk to Ragman',h:'Unlocks Interchange map'},
    {t:'Extract Interchange',h:'Survive and extract with any status'},
    {t:'Talk to Skier',h:'Unlocks Customs map'},
    {t:'Extract Customs',h:'Survive and extract with any status'},
    {t:'Give 5 materials',h:'Any Building Materials (Found in Raid)'},
    {t:'Talk to Mechanic',h:'Unlocks Factory map'},
    {t:'Extract Factory',h:'Survive and extract with any status'},
    {t:'Give 2 weapons',h:'Any weapons found in raid'},
    {t:'Kill 3 on Woods',h:'Any enemies - Scavs, PMCs, or bosses'},
    {t:'Extract Woods',h:'Survive and extract with any status'},
    {t:'Find Terminal entrance',h:'SE Shoreline near Road to Customs'},
    {t:'Use intercom',h:'Tower base - stay away from walls!'},
    {t:'Extract Shoreline',h:'Survive and extract with any status'},
    {t:'Pay $20K',h:'Buy dollars from Peacekeeper'},
    {t:'Give 5 dogtags',h:'Loot from dead PMCs (any level)'},
    {t:'Access Lab',h:'Transit from Factory basement or Streets'},
    {t:'Search Lab offices',h:'Manager office O21, second level'},
    {t:'Search server room',h:'Next to warehouse, first level'},
    {t:'Find drainage escape',h:'Sewage Conduit extract underground'}
  ]},
  falling_skies: { name: 'Falling Skies', icon: '✈️', clr: 'orange', tasks: [
    {t:'Find crashed plane',h:'Woods near Jaeger camp area'},
    {t:'Reach Prapor LL2',h:'Complete Prapor quests for loyalty'},
    {t:'Ask about plane',h:'Talk to traders in menu'},
    {t:'(Opt) Pay $2K',h:'Therapist hint for G-Wagon location'},
    {t:'Get flash drive',h:'Black G-Wagon near Tunnel, Shoreline'},
    {t:'Give to Prapor',h:'Hand over the flash drive'},
    {t:'Wait 1h',h:'Real-time wait'},
    {t:'Get flight recorder',h:'Under plane, starboard/north side'},
    {t:'Leave at Fisher Island',h:'Corner room in island house'},
    {t:'Get transcript',h:'Chairman House, NW Shoreline swamp'},
    {t:'Give transcript',h:'Hand over to Prapor'},
    {t:'Wait 1h',h:'Real-time wait'},
    {t:'Get armored case',h:'Plane cockpit on Woods'},
    {t:'⚠️ CASE CHOICE',h:'MAJOR DECISION - affects endings!',choice:'falling_skies_case'}
  ]},
  batya: { name: 'Batya', icon: '🐻', clr: 'yellow', tasks: [
    {t:'Find BEAR outpost',h:'Stronghold, Resort tank, or USEC rock'},
    {t:'Get Bogatyr Patch',h:'Power station trailer, south of Gas'},
    {t:'Read patch',h:'Inspect in inventory'},
    {t:'Visit Gnezdo',h:'BEAR outpost on Customs'},
    {t:'Visit Ryabina',h:'Behind Sanatorium, Shoreline'},
    {t:'Find grave',h:'Moreman grave on Woods'},
    {t:'Craft tapes',h:'Workbench - RAM, batteries, wires'},
    {t:'Listen tapes',h:'Play both in Handbook'},
    {t:'Contact squad',h:'Requires Intel Center Level 3'},
    {t:'Bring items to LK',h:'All Bogatyr items to Lightkeeper'},
    {t:'Combat challenges',h:'15 kills no death, 4 PMC streak'},
    {t:'Wait 24h',h:'Real-time wait for documents'},
    {t:'Collect docs',h:'Red box at LK sliding door entrance'}
  ]},
  accidental_witness: { name: 'Accidental Witness', icon: '🚗', clr: 'zinc', tasks: [
    {t:'Find scribbled car',h:'Dorms courtyard parking, Customs'},
    {t:'Find Kozlov location',h:'Two-story dorms building'},
    {t:'Read door note',h:'Wall next to Room 110 door'},
    {t:'(Opt) Enter room',h:'Need Dorm Room 110 key'},
    {t:'Ask about Anastasia',h:'Talk to Skier'},
    {t:'Access apt',h:'Zmeisky Alley bldg 3, Streets'},
    {t:'Read docs',h:'Documents inside apartment'}
  ]},
  they_are_already_here: { name: 'They Are Already Here', icon: '👁️', clr: 'violet', tasks: [
    {t:'Find cult note',h:'Marked circles or kill Cultist'},
    {t:'Find torture house',h:'Flooded village, Lighthouse'},
    {t:'Get tape & key',h:'Tape on chair, key on table'},
    {t:'Search apt',h:'Apt 69, north of Stylobate, Streets'},
    {t:'Find Book',h:'Bookshelf in Igor office'},
    {t:'Check village',h:'Two houses near church, Woods'},
    {t:'Read newspaper',h:'Tarkov Lights on photo board'},
    {t:'Find chalet note',h:'Lower chalet balcony, Lighthouse'},
    {t:'Get KORD key',h:'On ATV outside two-story house'},
    {t:'Reprogram card',h:'Workbench craft'},
    {t:'Kill 2 Priests',h:'Cultist Priests on night raids'},
    {t:'Get priest note',h:'Marked room 314 or RB-BK'},
    {t:'Access ARRS',h:'Use reprogrammed card at 14-4'},
    {t:'Give USB',h:'Hand to Mechanic'},
    {t:'Read specs',h:'Check messages'}
  ]},
  blue_fire: { name: 'Blue Fire', icon: '⚡', clr: 'cyan', tasks: [
    {t:'Find leaflet',h:'Green container, Woods Scav base'},
    {t:'Get fragment',h:'Scav/Cultist areas, Streets/GZ'},
    {t:'Check Post Office',h:'Primorsky Ave, Streets'},
    {t:'Collect tapes',h:'3 tapes in Post Office'},
    {t:'Get car key',h:'Under van rear wheel'},
    {t:'Get blueprints',h:'Inside post van'},
    {t:'Sell or keep',h:'Sell to Mechanic or keep'}
  ]},
  the_ticket: { name: 'The Ticket', icon: '🎫', clr: 'rose', tasks: [
    {t:'Wait for Kerman',h:'Message notification'},
    {t:'Contact Kerman',h:'Use Intel Center in Hideout'},
    {t:'⚠️ WORK WITH KERMAN?',h:'Opens Savior or locks Survivor',choice:'ticket_kerman'},
    {t:'Find Jammer',h:'Signal Jammer in Lab (3 spots)'},
    {t:'Unlock case (55h)',h:'Workbench - uninterrupted power!'},
    {t:'⚠️ GATHER EVIDENCE?',h:'YES=Savior, NO=Betray',choice:'ticket_evidence'},
    {t:'Wait for Elektronik',h:'Real-time wait after Mechanic'},
    {t:'Pay 40 BTC',h:'40 Bitcoin to Mechanic at once'},
    {t:'Get RFID device',h:'Apt 2, Klimova 14A, under table'},
    {t:'Get Kruglov card',h:'Lab safe - needs Black keycard'},
    {t:'Access hidden room',h:'Cardinal Apt 1, TerraGroup key'},
    {t:'⚠️ FINAL PATH?',h:'Prapor=Fallen, LK=Debtor',choice:'ticket_final'}
  ]},
  the_unheard: { name: 'The Unheard', icon: '🔇', clr: 'gray', tasks: [
    {t:'Find Purification note',h:'TerraGroup security post or GZ'},
    {t:'Get Cargo Fax',h:'Dark office 022, Lab 2nd floor'},
    {t:'Find doc',h:'Enterprise doc, Lab testing area'},
    {t:'Get burnt doc',h:'TerraGroup storage, Factory'},
    {t:'Get HDD',h:'Gray G-Wagon near LexOs, Streets'},
    {t:'Get USB',h:'Resort East 305, Shoreline'},
    {t:'Check whiteboard',h:'Announcement board in Lab'},
    {t:'Wait 4h',h:'Real-time wait for Kerman'},
    {t:'Access apt',h:'A.P. hidden room, Cardinal'},
    {t:'Read notes',h:'All 4 notes in hidden room'}
  ]},
  the_labyrinth: { name: 'The Labyrinth', icon: '🏛️', clr: 'indigo', tasks: [
    {t:'Find transit',h:'Resort west wing basement'},
    {t:'Get Knossos key',h:'Admin Resort, 5 spawn spots'},
    {t:'Ask traders',h:'Jaeger knows about BEAR squad'},
    {t:'Wait for Jaeger',h:'24-48h for keycard barter'},
    {t:'Get keycards',h:'2 free + barter from Jaeger'},
    {t:'Enter Labyrinth',h:'Knossos + Labrys at transit'},
    {t:'Solve puzzle',h:'Each spawn has unique trap'},
    {t:'Find bodies',h:'Inspect all BEAR bodies'},
    {t:'Get 5 notes',h:'Research Notes in Labyrinth'},
    {t:'Find leader',h:'Squad leader body'},
    {t:'Access locked room',h:'Key from assistant body'},
    {t:'Get report',h:'Drainage near yacht club'},
    {t:'Give tape',h:'To Jaeger - AXMC + 500K₽'}
  ]}
};

const ORD = Object.keys(CH);
const CLR = {emerald:'#10b981',orange:'#f97316',yellow:'#eab308',zinc:'#71717a',violet:'#8b5cf6',cyan:'#06b6d4',rose:'#f43f5e',gray:'#6b7280',indigo:'#6366f1',amber:'#f59e0b',slate:'#64748b',red:'#ef4444',purple:'#a855f7'};

function Tooltip({ text, children }) {
  const [show, setShow] = useState(false);
  const timer = useRef(null);
  const start = () => { timer.current = setTimeout(() => setShow(true), 500); };
  const end = () => { clearTimeout(timer.current); setShow(false); };
  
  return (
    <div className="relative" onMouseEnter={start} onMouseLeave={end} onTouchStart={start} onTouchEnd={end}>
      {children}
      {show && text && (
        <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 border border-amber-500/60 rounded-lg text-xs text-gray-200 whitespace-normal max-w-[200px] text-center shadow-xl">
          {text}
          <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-amber-500/60"/>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [exp, setExp] = useState(null);
  const [prog, setProg] = useState({});
  const [dec, setDec] = useState({});
  const [load, setLoad] = useState(true);
  const [modal, setModal] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [p, d] = await Promise.all([window.storage.get('eft-p4'), window.storage.get('eft-d4')]);
        if (p?.value) setProg(JSON.parse(p.value));
        if (d?.value) setDec(JSON.parse(d.value));
      } catch(e) {}
      setLoad(false);
    })();
  }, []);

  useEffect(() => {
    if (!load) {
      (async () => {
        try { await Promise.all([window.storage.set('eft-p4', JSON.stringify(prog)), window.storage.set('eft-d4', JSON.stringify(dec))]); } catch(e) {}
      })();
    }
  }, [prog, dec, load]);

  const toggle = (ch, i, choice) => {
    if (choice) { setModal(choice); return; }
    setProg(p => ({ ...p, [`${ch}-${i}`]: !p[`${ch}-${i}`] }));
  };

  const decide = (did, opt) => {
    const d = DECISIONS[did];
    setDec(x => ({ ...x, [did]: opt }));
    setProg(p => ({ ...p, [`${d.chapter}-${d.taskId}`]: true }));
    setModal(null);
  };

  const getProbs = () => {
    if (dec.ticket_kerman === 'no') return { savior: 0, survivor: 100, fallen: 0, debtor: 0 };
    if (dec.ticket_kerman === 'yes') {
      if (dec.ticket_evidence === 'yes') return { savior: 100, survivor: 0, fallen: 0, debtor: 0 };
      if (dec.ticket_evidence === 'no') {
        if (dec.ticket_final === 'prapor') return { savior: 0, survivor: 0, fallen: 100, debtor: 0 };
        if (dec.ticket_final === 'lk') return { savior: 0, survivor: 0, fallen: 0, debtor: 100 };
        return { savior: 0, survivor: 0, fallen: 50, debtor: 50 };
      }
      return { savior: 50, survivor: 0, fallen: 25, debtor: 25 };
    }
    if (dec.falling_skies_case === 'give_prapor') return { savior: 25, survivor: 35, fallen: 20, debtor: 20 };
    if (dec.falling_skies_case === 'keep_case') return { savior: 40, survivor: 10, fallen: 25, debtor: 25 };
    return { savior: 25, survivor: 25, fallen: 25, debtor: 25 };
  };

  const getProg = ch => {
    const done = CH[ch].tasks.filter((_, i) => prog[`${ch}-${i}`]).length;
    return { done, total: CH[ch].tasks.length, pct: Math.round((done / CH[ch].tasks.length) * 100) };
  };

  const getTotal = () => {
    let done = 0, total = 0;
    ORD.forEach(ch => { const p = getProg(ch); done += p.done; total += p.total; });
    return { done, total, pct: Math.round((done / total) * 100) };
  };

  const getNextTask = (ch) => {
    const idx = CH[ch].tasks.findIndex((_, i) => !prog[`${ch}-${i}`]);
    return idx;
  };

  const reset = async () => {
    if (confirm('Reset all progress and decisions?')) {
      setProg({}); setDec({});
      try { await Promise.all([window.storage.delete('eft-p4'), window.storage.delete('eft-d4')]); } catch(e) {}
    }
  };

  const expandAll = () => setExp(exp === 'all' ? null : 'all');

  if (load) return <div className="min-h-screen bg-gray-900 flex items-center justify-center text-amber-400"><Sparkles className="animate-spin mr-2" />Loading...</div>;

  const probs = getProbs();
  const maxP = Math.max(...Object.values(probs));
  const best = Object.entries(probs).filter(([,v]) => v === maxP)[0][0];
  const e = ENDINGS[best];
  const total = getTotal();

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-slate-900 to-zinc-900 text-gray-100 p-3 pb-20">
      <div className="max-w-xl mx-auto">
        <h1 className="text-xl font-bold text-center bg-gradient-to-r from-amber-400 to-red-500 bg-clip-text text-transparent mb-1">ESCAPE FROM TARKOV</h1>
        <p className="text-center text-gray-500 text-xs mb-4">Story & Ending Tracker</p>

        {/* Ending Predictor */}
        <div className="rounded-xl p-4 mb-4 border-2" style={{borderColor: CLR[e.clr], background: `${CLR[e.clr]}15`}}>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-4xl">{e.icon}</span>
            <div className="flex-1">
              <div className="font-bold text-lg flex items-center gap-2">
                {maxP === 100 ? '🔒' : '🎯'} {e.name}
                {maxP === 100 && <span className="text-xs bg-green-500/30 text-green-300 px-2 py-0.5 rounded">LOCKED</span>}
              </div>
              <div className="text-xs text-gray-400">{e.sub} • {e.desc}</div>
            </div>
          </div>
          
          <div className="grid grid-cols-4 gap-2 mb-3">
            {Object.entries(ENDINGS).map(([id, en]) => (
              <Tooltip key={id} text={en.desc}>
                <div className={`p-2 rounded-lg text-center border cursor-help ${probs[id] > 0 ? 'border-white/20' : 'border-transparent opacity-30'}`} style={{background: probs[id] > 0 ? `${CLR[en.clr]}20` : ''}}>
                  <div className="text-lg">{en.icon}</div>
                  <div className="text-xs truncate">{en.name}</div>
                  <div className={`font-bold ${probs[id] === 100 ? 'text-green-400' : ''}`}>{probs[id]}%</div>
                </div>
              </Tooltip>
            ))}
          </div>

          {Object.keys(dec).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {Object.entries(dec).map(([did, val]) => {
                const d = DECISIONS[did];
                const o = d.opts.find(x => x.id === val);
                return <span key={did} className="px-2 py-0.5 bg-black/30 rounded text-xs">{o?.icon} {o?.label}</span>;
              })}
            </div>
          )}
        </div>

        {/* Progress Bar */}
        <div className="bg-gray-800/50 rounded-xl p-3 mb-4 border border-gray-700/50 flex items-center gap-3">
          <Trophy className="text-amber-400 flex-shrink-0" size={20}/>
          <div className="flex-1">
            <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-amber-500 transition-all" style={{width:`${total.pct}%`}}/>
            </div>
            <div className="text-xs text-gray-500 mt-1">{total.done}/{total.total} tasks</div>
          </div>
          <span className="text-amber-400 font-bold text-lg">{total.pct}%</span>
          <button onClick={expandAll} className="text-gray-500 hover:text-amber-400 p-1" title="Expand/Collapse All">
            <ChevronsUpDown size={18}/>
          </button>
          <button onClick={reset} className="text-gray-500 hover:text-red-400 p-1" title="Reset">
            <RotateCcw size={16}/>
          </button>
        </div>

        {/* Chapters */}
        {ORD.map((cid, idx) => {
          const ch = CH[cid];
          const pr = getProg(cid);
          const isExp = exp === cid || exp === 'all';
          const nextIdx = getNextTask(cid);

          return (
            <div key={cid} className={`rounded-xl overflow-hidden border mb-2 ${pr.pct === 100 ? 'border-green-500/50' : 'border-gray-700/40'}`} style={{background: pr.pct === 100 ? '#10b98110' : '#1f293780'}}>
              <button onClick={() => setExp(isExp && exp !== 'all' ? null : cid)} className="w-full p-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center text-lg flex-shrink-0" style={{background: CLR[ch.clr]}}>{ch.icon}</div>
                <div className="flex-1 text-left min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-xs">#{idx+1}</span>
                    <span className="font-medium truncate">{ch.name}</span>
                    {pr.pct === 100 && <Check className="text-green-400 flex-shrink-0" size={14}/>}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1.5 bg-gray-700 rounded-full max-w-32">
                      <div className="h-full rounded-full transition-all" style={{width:`${pr.pct}%`, background: CLR[ch.clr]}}/>
                    </div>
                    <span className="text-xs text-gray-500">{pr.done}/{pr.total}</span>
                  </div>
                </div>
                {isExp ? <ChevronDown size={18} className="text-gray-500 flex-shrink-0"/> : <ChevronRight size={18} className="text-gray-500 flex-shrink-0"/>}
              </button>

              {isExp && (
                <div className="border-t border-gray-700/50 p-2 bg-gray-900/50">
                  {ch.tasks.map((task, i) => {
                    const done = prog[`${cid}-${i}`];
                    const isChoice = !!task.choice;
                    const hasDecided = task.choice && dec[task.choice];
                    const isNext = i === nextIdx && !done;

                    return (
                      <Tooltip key={i} text={task.h}>
                        <button 
                          onClick={() => toggle(cid, i, task.choice)} 
                          className={`w-full flex items-center gap-2 p-2 rounded-lg transition-all ${done ? 'bg-green-900/20' : isChoice ? 'bg-amber-900/20 hover:bg-amber-800/30' : isNext ? 'bg-blue-900/20 hover:bg-blue-800/30' : 'hover:bg-gray-800/50'}`}
                        >
                          <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${done ? 'bg-green-500 border-green-500' : isChoice ? 'border-amber-500' : isNext ? 'border-blue-400' : 'border-gray-600'}`}>
                            {done && <Check size={12} className="text-white"/>}
                            {isChoice && !done && <AlertTriangle size={10} className="text-amber-400"/>}
                            {isNext && !isChoice && <span className="text-blue-400 text-xs font-bold">→</span>}
                          </div>
                          <span className={`flex-1 text-left text-sm truncate ${done ? 'text-gray-500 line-through' : isChoice ? 'text-amber-300' : isNext ? 'text-blue-300' : ''}`}>{task.t}</span>
                          {hasDecided && <span className="text-xs bg-gray-700/50 px-2 py-0.5 rounded flex-shrink-0">{DECISIONS[task.choice].opts.find(o => o.id === dec[task.choice])?.icon}</span>}
                        </button>
                      </Tooltip>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        <div className="text-center mt-6 text-gray-600 text-xs">
          <a href="https://escapefromtarkov.fandom.com/wiki/Story_chapters" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-amber-400">
            <ExternalLink size={12}/> EFT Wiki
          </a>
        </div>
      </div>

      {/* Decision Modal */}
      {modal && DECISIONS[modal] && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50" onClick={() => setModal(null)}>
          <div className="bg-gray-800 rounded-2xl p-5 max-w-sm w-full border border-gray-600" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-lg flex items-center gap-2"><AlertTriangle className="text-amber-400"/> Decision Point</h3>
              <button onClick={() => setModal(null)} className="text-gray-400 hover:text-white"><X size={20}/></button>
            </div>
            <p className="text-gray-300 mb-4">{DECISIONS[modal].q}</p>
            <div className="space-y-2">
              {DECISIONS[modal].opts.map(o => (
                <button key={o.id} onClick={() => decide(modal, o.id)} className={`w-full p-3 rounded-xl border-2 text-left transition-all hover:scale-[1.02] ${dec[modal] === o.id ? 'border-amber-400 bg-amber-900/30' : 'border-gray-600 hover:border-gray-500'}`}>
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{o.icon}</span>
                    <div>
                      <div className="font-medium">{o.label}</div>
                      <div className="text-xs text-gray-400">{o.d}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-4 text-center">⚠️ This choice affects your ending!</p>
          </div>
        </div>
      )}
    </div>
  );
}