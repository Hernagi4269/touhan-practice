(function(){
  const normalize=value=>String(value??'').replace(/\s+/g,' ').trim();
  const jp=/[一-龯ぁ-んァ-ヶ]/g;
  function structuredStatements(q){
    if(Array.isArray(q?.statements)){
      const out={};
      for(const row of q.statements){
        const label=String(row?.label??'').normalize('NFKC').toLowerCase().trim();
        const text=normalize(row?.text);
        if(/^[a-d]$/.test(label)&&text&&!out[label])out[label]=text;
      }
      if(Object.keys(out).length)return out;
    }
    const raw=String(q?.question_text??'').replace(/\r/g,'').normalize('NFKC');
    const matches=[...raw.matchAll(/(?:^|\n)\s*([a-d])\s+([\s\S]*?)(?=(?:\n\s*[a-d]\s+)|$)/g)];
    const out={};
    for(const m of matches){const text=normalize(m[2]);if(text&&!out[m[1]])out[m[1]]=text;}
    return out;
  }
  function ocrQualityReasons(q,choices){
    const reasons=[]; const text=String(q.question_text??''); const statements=Object.values(structuredStatements(q)); const joined=[text,...statements,...choices].join(' ');
    const jpCount=(text.match(jp)||[]).length;
    const spaced=(text.match(/[一-龯ぁ-んァ-ヶ]\s+[一-龯ぁ-んァ-ヶ]/g)||[]).length;
    if(jpCount>0&&spaced/jpCount>0.28) reasons.push('文字間空白が多い');
    if(/(?:\*RRG|&OLQLFDO|3UDFWLFH|\b(?:REKE|BREEAD|BREEED)\b|[#®])/.test(joined)) reasons.push('OCRノイズ記号');
    if(joined.includes('�')) reasons.push('文字化け');
    const combo=choices.filter(x=>/^[（(]?[a-dａ-ｄ][,、，]\s*[a-dａ-ｄ][)）]?$/i.test(x)).length;
    const hasStatements=Object.keys(structuredStatements(q)).length>0;
    if(combo>=4&&!hasStatements) reasons.push('組合せ対象の記述欠落');
    if(choices.some(x=>x.length>25&&/[にのをがでとやし]$/.test(x))) reasons.push('選択肢末尾欠落');
    return reasons;
  }

  function statementLabels(text){
    const raw=String(text??'').replace(/\r/g,'').normalize('NFKC');
    return [...new Set([...raw.matchAll(/(?:^|\n)\s*([a-d])\s+\S/g)].map(m=>m[1].toLowerCase()))];
  }
  function structuralReasons(q,choices){
    const reasons=[];
    const text=String(q.question_text??'');
    const direct=Array.isArray(q?.statements)?q.statements:[];
    const labels=[...new Set(direct.map(x=>String(x?.label??'').normalize('NFKC').toLowerCase()).filter(x=>/^[a-d]$/.test(x)))];
    const fallback=labels.length?labels:statementLabels(text);
    const marksPerChoice=choices.map(x=>(String(x).match(/[正誤]/g)||[]).length);
    const expectedTruth=Math.max(0,...marksPerChoice);
    const pairPattern=/^[（(]?\s*([a-dａ-ｄ])\s*[,、・]\s*([a-dａ-ｄ])\s*[）)]?$/i;
    const pairChoices=choices.map(x=>String(x).match(pairPattern)).filter(Boolean);
    const isTruthTable=choices.length===5&&expectedTruth>=3;
    const isPair=/組合せはどれか/.test(text)&&pairChoices.length>=4;
    const expected=isTruthTable?expectedTruth:(isPair?Math.max(...pairChoices.flatMap(m=>[m[1],m[2]]).map(x=>x.normalize('NFKC').toLowerCase().charCodeAt(0)-96),0):0);
    if((isTruthTable||isPair)&&fallback.length<expected)reasons.push(`組合せ対象の記述欠落（${fallback.join(',')||'なし'} / 必要${expected}件）`);
    return reasons;
  }

  function validateQuestion(q){
    const reasons=[];
    const cleanChoice=x=>normalize(x).replace(/(?:人体の働きと医薬品|薬事に関する法規と制度|主な医薬品とその作用|医薬品の適正使用と安全対策)$/,'').trim();
    const choices=Array.isArray(q.choices)?q.choices.map(cleanChoice):[];
    if(q?.quality?.status && q.quality.status!=='ok')reasons.push(`抽出品質:${q.quality.status}`);
    if(!q.question_id) reasons.push('question_idなし');
    if(!normalize(q.question_text)||normalize(q.question_text).length<20) reasons.push('問題文不足');
    if(!/^第[1-5]章$/.test(normalize(q.chapter))) reasons.push('章が不正');
    if(choices.length!==5) reasons.push(`選択肢${choices.length}件`);
    if(choices.some(x=>!(x||'').trim())) reasons.push('空の選択肢');
    if(new Set(choices.map(x=>x.replace(/[\s,、()（）]/g,''))).size!==choices.length) reasons.push('選択肢重複');
    if(!['1','2','3','4','5'].includes(String(q.answer))) reasons.push('正答不正');
    if(!q.year) reasons.push('年度なし');
    reasons.push(...ocrQualityReasons(q,choices));
    reasons.push(...structuralReasons(q,choices));
    return {ok:reasons.length===0,reasons,choices};
  }
  function validateDatabase(db){
    const list=Array.isArray(db)?db:(Array.isArray(db?.questions)?db.questions:[]); const seen=new Set(),valid=[],invalid=[],duplicateIds=[]; const chapterCounts={},yearCounts={};
    for(const q of list){if(seen.has(q.question_id)){duplicateIds.push(q.question_id);invalid.push({id:q.question_id,reasons:['ID重複']});continue;}seen.add(q.question_id);const r=validateQuestion(q);if(r.ok){valid.push({...q,choices:r.choices});chapterCounts[q.chapter]=(chapterCounts[q.chapter]||0)+1;yearCounts[q.year]=(yearCounts[q.year]||0)+1;}else invalid.push({id:q.question_id||'(なし)',year:q.year,no:q.question_no,reasons:r.reasons});}
    return {total:list.length,valid,invalid,validCount:valid.length,invalidCount:invalid.length,duplicateIds,chapterCounts,yearCounts};
  }
  window.TouhanValidator={validateQuestion,validateDatabase,structuredStatements};
})();
(function(){
  let explanationByQuestion=new Map();
  function setExplanationData(rows){
    explanationByQuestion=new Map();
    for(const row of (Array.isArray(rows)?rows:[])){
      if(row?.questionId)explanationByQuestion.set(String(row.questionId),row);
    }
  }
  function explanationForStatement(sourceQuestionId,label){
    const row=explanationByQuestion.get(String(sourceQuestionId||''));
    return row?.statements?.find(x=>String(x?.label||'').toLowerCase()===String(label||'').toLowerCase())||null;
  }
  function explanationsForQuestion(sourceQuestionId){
    return explanationByQuestion.get(String(sourceQuestionId||''))?.statements||[];
  }
  const DISTRIBUTIONS={
    one_by_one:{'第1章':5,'第2章':5,'第3章':10,'第4章':5,'第5章':5},
    practice60:{'第1章':10,'第2章':10,'第3章':20,'第4章':10,'第5章':10},
    exam_am:{'第1章':20,'第2章':20,'第4章':20},
    exam_pm:{'第3章':40,'第5章':20}
  };
  const HISTORY_KEY='touhan.engine.generator.history.v120',LEARNING_KEY='touhan.engine.learning.state.v1';

  function hashSeed(text){let h=2166136261;for(const c of text){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
  function rng(seed){let a=seed>>>0;return()=>{a+=0x6D2B79F5;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}
  function shuffle(list,random){const a=[...list];for(let i=a.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
  function history(){try{return JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]')}catch{return[]}}
  function learningState(){try{return JSON.parse(localStorage.getItem(LEARNING_KEY)||'null')}catch{return null}}
  function learningMap(){const s=learningState(),m=new Map();for(const q of (s?.questions||[]))if(q?.knowledgeId)m.set(String(q.knowledgeId),q);return m}
  function generatedCounts(){const m=new Map();for(const row of history())for(const id of (row.questionIds||[]))m.set(String(id),(m.get(String(id))||0)+1);return m}
  function recentIds(category,days=3){return new Set(history().filter(x=>x.category===category).slice(-days).flatMap(x=>x.questionIds||[]))}
  function priorityScore(q,random,learn,generated){
    const id=String(q.question_id),s=learn.get(id)||{},gen=generated.get(id)||0,shown=Math.max(Number(s.shownCount)||0,gen),wrong=Number(s.wrongCount)||0,uncertain=Number(s.uncertainCount)||0,unknown=Number(s.unknownCount)||0;
    let tier=0;if(shown===0)tier=300000;else if(wrong>0||unknown>0||uncertain>0)tier=200000;else tier=100000;
    let stale=0;if(s.lastAnsweredAt){const d=(Date.now()-Date.parse(s.lastAnsweredAt))/86400000;if(Number.isFinite(d))stale=Math.max(0,Math.min(365,d));}
    return tier+wrong*1500+unknown*1250+uncertain*1000+stale*10-shown*250+random()*80;
  }
  function pick(pool,count,random,blocked,selected,selectedQuestions=[],duplicateGuard=null,topicSet=null){
    const learn=learningMap(),generated=generatedCounts(),years={};
    for(const q of pool)(years[q.year]??=[]).push(q);
    Object.keys(years).forEach(y=>years[y]=years[y].map(q=>({q,score:priorityScore(q,random,learn,generated)})).sort((a,b)=>b.score-a.score).map(x=>x.q));
    const ys=shuffle(Object.keys(years),random),out=[];let c=0,g=0;
    while(out.length<count&&ys.length&&g++<30000){const y=ys[c++%ys.length];let q;while(years[y].length&&!q){const x=years[y].shift();if(selected.has(x.question_id))continue;if(blocked.has(x.question_id)&&((learningMap().get(String(x.question_id))?.wrongCount||0)===0)&&((learningMap().get(String(x.question_id))?.unknownCount||0)===0)&&((learningMap().get(String(x.question_id))?.uncertainCount||0)===0))continue;if(duplicateGuard&&duplicateGuard(x,selectedQuestions))continue;if(topicSet&&hasTopicConflict(x,topicSet))continue;q=x}if(q){out.push(q);selected.add(q.question_id);selectedQuestions.push(q);if(topicSet)addTopicKeys(q,topicSet)}if(ys.every(k=>years[k].length===0))break}
    return out;
  }

  function removeRubyLines(value){
    const lines=String(value??'').replace(/\r/g,'').split('\n').map(x=>x.trim());
    return lines.filter((line,i)=>{
      if(!/^[ぁ-んァ-ヶー]{1,8}$/.test(line))return true;
      const prev=lines[i-1]||'', next=lines[i+1]||'';
      return !(/[一-龯々〆ヵヶ]$/.test(prev)&&next.length>0);
    }).join('\n');
  }
  function stripSourceQuestionNumber(value){
    return String(value??'')
      .replace(/^\s*[【［(（]?\s*(?:第\s*)?問\s*[０-９0-9]+\s*[】］)）.:：、-]*\s*/u,'')
      .replace(/^\s*[【［(（]?\s*第\s*[０-９0-9]+\s*問\s*[】］)）.:：、-]*\s*/u,'');
  }
  const TEXT_FIXES=[
    [/蕁\s*じん\s*麻疹\s*しん/g,'蕁麻疹'],[/痒\s*かゆ\s*み/g,'痒み'],[/罹\s*り\s*患/g,'罹患'],
    [/咀\s*嚼/g,'咀嚼'],[/酸\s*そ\s*しゃく\s*性/g,'酸性'],[/口腔\s*くう/g,'口腔'],
    [/排泄\s*せつ/g,'排泄'],[/咳\s*せき/g,'咳'],[/痰\s*たん/g,'痰'],[/喘\s*ぜん\s*息/g,'喘息'],
    [/嘔\s*おう\s*吐/g,'嘔吐'],[/倦\s*けん\s*怠/g,'倦怠'],[/嚥\s*えん\s*下/g,'嚥下'],
    [/収斂\s*れん/g,'収斂'],[/止瀉\s*しゃ/g,'止瀉'],[/鎮咳\s*がい/g,'鎮咳'],[/去痰\s*たん/g,'去痰'],
    [/含嗽\s*そう/g,'含嗽'],[/鎮暈\s*うん/g,'鎮暈'],[/疳\s*かん/g,'疳'],[/亢\s*こう\s*進/g,'亢進'],
    [/弛\s*し\s*緩/g,'弛緩'],[/鱗\s*りん\s*茎/g,'鱗茎'],[/膨\s*ぼう\s*潤/g,'膨潤'],
    [/頻\s*ひん\s*脈/g,'頻脈'],[/浮腫\s*しゅ/g,'浮腫'],[/腫脹\s*ちょう/g,'腫脹'],[/くう\s*くう(?=口腔)/g,''],[/い\s*たん\s*じ(?=を示し)/g,''],[/作用がを示し/g,'作用を示し']
  ];
  function cleanText(value,{stripQuestionNo=false}={}){
    let text=removeRubyLines(value)
      .replace(/([一-龯々〆ヵヶ])\|[ぁ-んァ-ヶー]{1,8}\|/g,'$1')
      .replace(/\|/g,'')
      .replace(/[ \t　]+/g,' ')
      .replace(/\s*\n\s*/g,'')
      .replace(/\s+([、。！？）】])/g,'$1')
      .replace(/([（【])\s+/g,'$1')
      .replace(/，/g,'、')
      .replace(/\s*－\s*/g,'－')
      .trim();
    for(const [pattern,replacement] of TEXT_FIXES)text=text.replace(pattern,replacement);
    text=text
      .replace(/([一-龯々]{2,})[ぁ-ん]{3,}(?:とう|さん|がん|えき)(?=[はをが、])/g,'$1')
      .replace(/([一-龯々ぁ-んァ-ヶー])\s+([一-龯々ぁ-んァ-ヶー])/g,'$1$2');
    if(stripQuestionNo)text=stripSourceQuestionNumber(text);
    return text;
  }

  function normalizeExamRaw(value){
    return removeRubyLines(String(value??''))
      .replace(/\r/g,'')
      .replace(/（\s*([ａ-ｄa-d])\s*）/g,(_,x)=>`（${x.normalize('NFKC').toLowerCase()}）`)
      .replace(/\(\s*([ａ-ｄa-d])\s*\)/g,(_,x)=>`（${x.normalize('NFKC').toLowerCase()}）`)
      .replace(/^[ \t　]*[0-9０-９]{1,2}[ \t　]*$/gm,'')
      .replace(/\n[ \t　]*問[０-９0-9]+[\s\S]*$/u,'')
      .trim();
  }

  function cleanExamParagraph(value){
    return cleanText(String(value??'').replace(/\n+/g,' '));
  }
  function sourceStatements(q){
    const direct=TouhanValidator?.structuredStatements?.(q)||{};
    const out={};
    for(const [label,text] of Object.entries(direct)){
      const cleaned=cleanExamParagraph(text);
      if(cleaned)out[label]=cleaned;
    }
    return Object.keys(out).length?out:extractLetterStatements(q);
  }

  function questionSemanticText(q){
    const prompt=examPrompt(q);
    const statements=Object.entries(sourceStatements(q)).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}:${v}`).join(' ');
    return `${prompt} ${statements}`.trim();
  }

  function examPrompt(q){
    const raw=normalizeExamRaw(q.question_text);
    const firstStatement=raw.search(/(?:^|\n)\s*[ａ-ｄa-d]\s+(?!）)/m);
    const promptSource=firstStatement>=0?raw.slice(0,firstStatement):raw;
    let prompt=cleanExamParagraph(promptSource);
    const complete=prompt.match(/^[\s\S]*?(?:どれか。|組合せはどれか。|正しいか。|誤っているか。)/);
    if(complete)prompt=complete[0].trim();
    return stripSourceQuestionNumber(prompt);
  }

  function placeholderLabels(q){
    const raw=normalizeExamRaw(q.question_text);
    return [...new Set((raw.match(/（([a-d])）/g)||[]).map(x=>x.slice(1,2)))];
  }

  function isFillBlankQuestion(q){
    const labels=placeholderLabels(q);
    return labels.length>0 && /中に入れるべき字句|字句の正しい組合せ/.test(cleanExamParagraph(q.question_text));
  }

  function formatFillBlankText(q){
    const raw=normalizeExamRaw(q.question_text);
    const prompt=examPrompt(q);
    const rawParas=raw.split(/\n\s*\n+/).map(x=>x.trim()).filter(Boolean);
    let body='';
    if(rawParas.length>=2){
      body=rawParas.slice(1).join('\n\n');
    }else{
      const marker=raw.match(/(?:組合せはどれ[\s\n]*か。|どれ[\s\n]*か。)/);
      body=marker?raw.slice(marker.index+marker[0].length):'';
    }
    body=body
      .replace(/^\s*(?:なお、[^。]*。\s*)?/,'')
      .replace(/\n\s*[ａ-ｄa-d](?:\s+[ａ-ｄa-d]){1,3}\s*$/m,'')
      .trim();
    const paras=body.split(/\n\s*\n+/).map(cleanExamParagraph).filter(x=>x&&!/^[a-d](?:\s+[a-d]){1,3}$/i.test(x));
    return [prompt,...paras].filter(Boolean).join('\n\n');
  }

  function splitPairStatement(text){
    const t=cleanExamParagraph(text);
    const parts=t.split(/\s*[―—ー－]{2,}\s*/).map(x=>x.trim()).filter(Boolean);
    if(parts.length>=2)return `${parts[0]}\n→ ${parts.slice(1).join(' ')}`;
    return t;
  }

  // 原問の対応表「左項目――右説明」を、一問一答として独立した命題へ変換する。
  // 罫線そのものはOCRノイズではないため、意味関係を保ったまま文章化する。
  function normalizeCorrespondenceStatement(value){
    const t=cleanExamParagraph(value);
    const parts=t.split(/\s*[―—ー－]{2,}\s*/).map(x=>x.trim()).filter(Boolean);
    if(parts.length<2)return t;
    const left=parts[0].replace(/[：:、，]$/,'').trim();
    const right=parts.slice(1).join(' ').replace(/^[：:、，]/,'').trim();
    if(!left||!right)return t;
    if(/[はがをにでとのへ]$/.test(left))return `${left}${right}`;
    return `${left}は、${right}`;
  }

  function formatExamQuestionText(q){
    if(isFillBlankQuestion(q))return formatFillBlankText(q);
    const prompt=examPrompt(q);
    const statements=sourceStatements(q);
    const blocks=Object.entries(statements)
      .sort(([a],[b])=>a.localeCompare(b))
      .map(([label,text])=>`【${label}】 ${splitPairStatement(text)}`);
    return blocks.length?[prompt,...blocks].filter(Boolean).join('\n\n'):prompt;
  }

  function splitChoiceCells(text,count){
    const raw=String(text??'').replace(/\r/g,'').trim();
    const cells=raw.split(/[ \t　]+/).map(cleanText).filter(Boolean);
    if(count>1 && cells.length===count)return cells;
    return null;
  }

  function formatExamChoiceText(q,text){
    const raw=String(text??'');
    const cleaned=cleanText(raw)
      .replace(/[（(]\s*([a-dａ-ｄ])\s*[,、]\s*([a-dａ-ｄ])\s*[）)]/gi,(_,a,b)=>`（${a.normalize('NFKC').toLowerCase()}・${b.normalize('NFKC').toLowerCase()}）`);
    const labels=placeholderLabels(q);
    if(labels.length){
      const cells=splitChoiceCells(raw,labels.length);
      if(cells)return cells.map((cell,i)=>`${labels[i]}：${cell}`).join('\n');
    }
    const marks=cleaned.match(/[正誤]/g)||[];
    if(marks.length>=3 && marks.length<=4){
      const ls=['a','b','c','d'].slice(0,marks.length);
      return ls.map((l,i)=>`${l}：${marks[i]}`).join('\n');
    }
    return cleaned;
  }

  function conciseOneByOneExplanation(statement,truth){
    let t=cleanText(statement);
    if(truth){
      return t.replace(/してください。?$/,'します。').replace(/することが適当である。?$/,'します。');
    }

    // 頻出の誤文は、誤り箇所だけでなく正しい知識へ直して表示する。
    const knowledgeRules=[
      {
        test:/副交感神経系.*肝臓.*グリコーゲン.*分解.*促進/,
        text:'肝臓でグリコーゲン分解を促進するのは交感神経系です。副交感神経系ではありません。'
      },
      {
        test:/交感神経系.*肝臓.*グリコーゲン.*合成.*促進/,
        text:'交感神経系は肝臓でグリコーゲン分解を促進し、血糖値を上げる方向に働きます。'
      },
      {
        test:/プリオン.*(?:脂質|細菌|ウイルス)/,
        text:'プリオンは細菌・ウイルス・脂質ではなく、異常化したタンパク質です。'
      },
      {
        test:/健康食品.*(?:指導|説明).*(?:対象ではない|必要はない)/,
        text:'健康食品でも、医薬品との相互作用や安全性に関する相談には適切な情報提供が必要です。'
      },
      {
        test:/副作用被害救済.*適正.*(?:請求できない|対象ではない)/,
        text:'医薬品を適正に使用して生じた健康被害は、副作用被害救済制度の対象となり得ます。'
      },
      {
        test:/要指導医薬品.*(?:インターネット|ネット).*(?:販売できる|販売可能)/,
        text:'要指導医薬品は使用者本人への対面販売が必要で、インターネット販売はできません。'
      },
      {
        test:/第一類医薬品.*登録販売者.*販売/,
        text:'第一類医薬品の販売と情報提供は薬剤師が行います。登録販売者は扱えません。'
      },
      {
        test:/一般用医薬品.*医療用医薬品.*リスクが高い/,
        text:'一般用医薬品は、医療用医薬品と比べて相対的にリスクが低いものとして扱われます。'
      },
      {
        test:/心臓.*静脈血のみ.*全身/,
        text:'左心室は酸素を多く含む動脈血を全身へ送り出します。'
      }
    ];
    for(const rule of knowledgeRules)if(rule.test.test(t))return rule.text;

    // 否定語だけが誤りの文は、正しい肯定文へ直す。
    const rules=[
      [/対象ではない。?$/,'対象です。'],[/ではない。?$/,'です。'],[/できない。?$/,'できます。'],
      [/必要はない。?$/,'必要です。'],[/生じることはない。?$/,'生じることがあります。'],
      [/行われない。?$/,'行われます。'],[/含まれていない。?$/,'含まれています。'],[/関与しない。?$/,'関与します。']
    ];
    for(const [pat,rep] of rules)if(pat.test(t))return t.replace(pat,rep);
    if(/^必ず/.test(t))return '「必ず」と一律に断定できません。条件や例外があります。';
    if(/(?:すべて|全て|一律)/.test(t))return 'すべてに一律に当てはまるわけではなく、条件や例外があります。';

    // 正しい内容を安全に自動復元できない場合、無内容な『誤りです』は表示しない。
    return '詳しい解説を参照してください。';
  }

  function detailedOneByOneExplanation(statement,truth,short){
    const t=cleanText(statement);
    if(truth)return short;
    if(short&&short!=='詳しい解説を参照してください。')return short;

    const patterns=[
      {re:/(.+)必要はない。?$/, build:m=>`誤っているのは「${m[1]}必要はない」としている点です。正しくは注意又は対応が必要です。`},
      {re:/(.+)ことはない。?$/, build:m=>`誤っているのは「${m[1]}ことはない」と断定している点です。実際には生じる場合があります。`},
      {re:/(.+)のみである。?$/, build:m=>`誤っているのは「${m[1]}のみ」と限定している点です。対象はそれだけに限られません。`},
      {re:/(.+)はない。?$/, build:m=>`誤っているのは「${m[1]}はない」と断定している点です。例外なく否定できる内容ではありません。`},
      {re:/(.+)できない。?$/, build:m=>`誤っているのは「${m[1]}できない」と断定している点です。条件によっては可能です。`},
      {re:/(.+)必ず(.+)。?$/, build:m=>`誤っているのは「必ず${m[2]}」と一律に断定している点です。条件や例外があります。`}
    ];
    for(const p of patterns){const m=t.match(p.re);if(m)return p.build(m);}
    return '誤り箇所の個別解説は未登録です。元の設問と正答を確認してください。';
  }
  function makeExamShortExplanation(q){
    const i=Number(q.answer)-1;
    const choice=q.choices?.[i];
    const text=choice==null?'':formatExamChoiceText(q,choice);
    return text?`正答は選択肢${q.answer}「${text.replace(/\n/g,'／')}」です。`:`正答は選択肢${q.answer}です。`;
  }
  function toExamQuestion(q,no){
    return {
      no,
      chapter:q.chapter,
      theme:`東京都${q.year}年度`,
      knowledge_id:q.question_id,
      source:`過去問（東京都${q.year}年度 問${q.question_no}）`,
      question_type:'single_best',
      text:formatExamQuestionText(q),
      choices:q.choices.map((text,i)=>({id:String(i+1),text:formatExamChoiceText(q,text)})),
      answer:String(q.answer),
      shortExplanation:makeExamShortExplanation(q),
      explanation:makeExamShortExplanation(q),
      source_question_id:q.question_id,
      topic_keys:topicKeys(q).filter(k=>!k.startsWith('source:')),
      statementExplanations:explanationsForQuestion(q.question_id).map(x=>({
        label:x.label,
        knowledgeId:x.knowledgeId,
        correctAnswer:x.correctAnswer,
        statement:x.statement,
        shortExplanation:x.shortExplanation,
        explanation:x.detailedExplanation,
        correction:x.correction,
        explanationStatus:x?.evidence?.status==='auto_matched'?'usable':'fallback',
        evidence:x.evidence||null
      }))
    };
  }

  function isChoiceTableHeaderLine(line){
    const compact=String(line??'').normalize('NFKC').toLowerCase().replace(/[\s　,、.・:：|｜()（）\[\]【】]/g,'');
    return compact==='abcd';
  }

  function extractLetterStatements(q){
    // 正誤表の列見出し「a b c d」は本文記述ではないため、解析前に除去する。
    const rawLines=normalizeExamRaw(q.question_text).split('\n');
    const kept=[];
    for(let i=0;i<rawLines.length;i++){
      const line=rawLines[i];
      const compact=String(line??'').normalize('NFKC').toLowerCase().replace(/[\s　,、.・:：|｜()（）\[\]【】]/g,'');
      const nextCompact=String(rawLines[i+1]??'').normalize('NFKC').toLowerCase().replace(/[\s　,、.・:：|｜()（）\[\]【】]/g,'');
      if(isChoiceTableHeaderLine(line))continue;
      // PDFの列見出しが「a b」「c d」の2行に分断された場合も除外する。
      if(/^ab$/.test(compact)&&/^cd(?:[ぁ-んァ-ヶー]*)?$/.test(nextCompact)){i++;continue;}
      kept.push(line);
    }
    const text=kept.join('\n');
    const matches=[...text.matchAll(/(?:^|\n)\s*([ａ-ｄa-d])\s+([\s\S]*?)(?=(?:\n\s*[ａ-ｄa-d]\s+)|(?:\n\s*[１-５1-5]\s*[（(])|(?:\n\s*[１-５1-5]\s+(?:正|誤))|$)/g)];
    const out={};
    for(const m of matches){
      const key=m[1].normalize('NFKC').toLowerCase();
      const body=cleanExamParagraph(m[2]).replace(/(?:１|1)[（(].*$/,'').trim();
      const bodyLettersOnly=body.normalize('NFKC').toLowerCase().replace(/[\s　,、.・:：|｜()（）\[\]【】]/g,'');
      const bogusHeader=/^[a-d]{2,4}[ぁ-んァ-ヶー]*$/.test(bodyLettersOnly);
      if(body.length>=2&&!bogusHeader&&!out[key])out[key]=body;
    }
    return out;
  }

  function requiredStatementCount(q){
    const choices=(q.choices||[]).map(x=>String(x??''));
    let maxTruth=0,maxLetters=0;
    for(const choice of choices){
      maxTruth=Math.max(maxTruth,(choice.match(/[正誤]/g)||[]).length);
      maxLetters=Math.max(maxLetters,new Set((choice.match(/[a-dａ-ｄ]/gi)||[]).map(x=>x.normalize('NFKC').toLowerCase())).size);
    }
    return Math.max(maxTruth,maxLetters);
  }

  function isUsableExamQuestion(q){
    const needed=requiredStatementCount(q);
    if(needed<3)return true;
    const statements=sourceStatements(q);
    return Object.keys(statements).length>=needed;
  }

  function selectedOptionFromText(q){
    const text=String(q.question_text??'').replace(/\r/g,'');
    const answer=String(q.answer).normalize('NFKC');
    const pairRows=[...text.matchAll(/(?:^|\s)([１-５1-5])\s*[（(]\s*([^）)]+?)\s*[）)]/g)];
    for(const m of pairRows){if(m[1].normalize('NFKC')===answer)return cleanText(m[2]);}
    const truthRows=[...text.matchAll(/(?:^|\n)\s*([１-５1-5])\s+((?:(?:正|誤)\s*){3,4})(?=\n|$)/g)];
    for(const m of truthRows){if(m[1].normalize('NFKC')===answer)return (m[2].match(/[正誤]/g)||[]).join(' ');}
    return cleanText(q.choices?.[Number(q.answer)-1]??'');
  }

  function truthFromPattern(q,statements){
    const selected=selectedOptionFromText(q);
    const letters=Object.keys(statements);
    if(!letters.length||!selected)return null;
    const marks=selected.match(/[正誤]/g)||[];
    if(marks.length>=letters.length){const map={};letters.forEach((k,i)=>map[k]=marks[i]==='正');return map;}
    const pair=(selected.match(/[a-dａ-ｄ]/gi)||[]).map(x=>x.normalize('NFKC').toLowerCase());
    if(pair.length>=2){
      const isIncorrectPair=/誤っているものの組合せ/.test(cleanText(q.question_text));
      const map={};letters.forEach(k=>map[k]=isIncorrectPair?!pair.includes(k):pair.includes(k));return map;
    }
    return null;
  }

  function sourcePromptText(q){
    return cleanText(q.question_text,{stripQuestionNo:true});
  }

  function isScenarioSourceQuestion(q){
    const p=sourcePromptText(q);
    return /(?:相談を受けた|相談内容|相談者|店舗を訪れた|来店した|購入するため|購入しようとして|患者|症例|事例|家族|息子|娘|お子|傷口|症状を訴え|次のような相談|使用していた|服用していた)/.test(p);
  }

  function sourceTopic(q){
    let p=sourcePromptText(q).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    const patterns=[
      /^(.*?)(?:に関する|についての|について、|に係る)次の記述(?:の正誤)?/,
      /^(.*?)(?:に関する|についての|について、|に係る)記述(?:の正誤)?/,
      /^(.*?)(?:に関する|についての|について、|に係る)次の文章/,
      /^(.*?)(?:に関する|についての|について、|に係る)/
    ];
    for(const pattern of patterns){
      const m=p.match(pattern);
      if(m&&m[1]){
        let topic=m[1].replace(/^(?:一般用医薬品|医薬品)を購入するために[^、。]*[、，]?/,'').replace(/(?:次の|以下の)$/,'').trim();
        if(topic.length>=4&&topic.length<=90)return topic;
      }
    }
    return '';
  }

  function statementNeedsContext(statement){
    const s=cleanText(statement);
    return /(?:報告の対象|報告がなされる|報告しなければ|因果関係|苦情の申立て|相談を受け付け|交付され|交付する|指定され|指定する|公表され|公表する|提供され|提供する|実施され|実施する|届出を|届け出|当該|これ|それ|この|その|同梱|廃止され|記載され|認めるとき|対象となり得る|場合であっても|使用を中止するよう|使用するよう|受診するよう)/.test(s);
  }

  function sourceRequiresTopic(q){
    const topic=sourceTopic(q);
    return /(?:センター|制度|報告|添付文書|法第|救済|認定|許可|届出|相談窓口|行政機関|厚生労働|都道府県知事|製造販売業者)/.test(topic);
  }

  function hasExplicitInstitutionalSubject(statement){
    const s=cleanText(statement);
    return /^(?:厚生労働大臣|都道府県知事|医薬品PLセンター|PMDA|独立行政法人医薬品医療機器総合機構|製造販売業者|薬局開設者|店舗販売業者|配置販売業者|医薬関係者|登録販売者|薬剤師|国|地方公共団体|報告者|申請者|購入者|消費者|患者)(?:は|が|には|では)/.test(s);
  }

  function contextualizeStatement(q,statement){
    const s=normalizeCorrespondenceStatement(statement);
    const topic=sourceTopic(q);
    if(!topic)return s;
    if(s.startsWith(topic)||s.includes(`${topic}は`)||s.includes(`${topic}では`)||s.includes(`${topic}について`))return s;

    // 選択肢だけでは対象薬・成分が分からない場合は、設問の主題を補う。
    const explicitTopicRequired=/(?:及びその配合成分|配合される.+の作用|の作用|使用上の注意|適正使用|副作用|効能効果)/.test(topic);
    const topicHead=topic
      .replace(/及びその配合成分.*$/,'')
      .replace(/に配合される(.+?)の作用.*$/,'$1')
      .replace(/の作用.*$/,'')
      .trim();
    const alreadyHasHead=topicHead.length>=3&&s.includes(topicHead);
    if(explicitTopicRequired&&!alreadyHasHead)return `${topic}について、${s}`;

    if(statementNeedsContext(s)||(sourceRequiresTopic(q)&&!hasExplicitInstitutionalSubject(s)))return `${topic}について、${s}`;
    return s;
  }

  function isMultiColumnTableSource(q){
    const prompt=cleanText(q?.question_text||'');
    const raw=cleanText(q?.raw_text||'');
    if(/殺菌消毒成分.*殺菌消毒作用又はその性質.*殺菌消毒作用を示す微生物等/.test(raw))return true;
    if(/「[^」]+」と「[^」]+」に関する/.test(prompt)&&/(?:a|ａ).*?(?:b|ｂ).*?(?:c|ｃ)/i.test(raw))return true;
    return false;
  }

  const KNOWN_CORRECTION_REGISTRY_VERSION='2026-07-28.1';
  const KNOWN_ONE_BY_ONE_CORRECTIONS={
    '2022:36:d':{
      statement:'ショック（アナフィラキシー）は、発症すると病態が急速に悪化することが多く、適切な対応が遅れるとチアノーゼや呼吸困難等を生じ、死に至ることがある。'
    },
    '2024:19:a':{
      statement:'HIV訴訟は、血友病患者が、HIVが混入した原料血漿から製造された血液凝固因子製剤の投与を受けたことにより、HIVに感染したことに対する損害賠償訴訟である。',
      truth:true
    },
    '2022:115:a':{
      statement:'緊急安全性情報は、厚生労働省からの命令、指示、製造販売業者の自主決定等に基づいて作成される。'
    },
    '2022:5:b':{
      statement:'外用薬では、アレルギーは引き起こされない。',
      truth:false
    }
  };
  function applyKnownOneByOneCorrection(item,q){
    const key=`${Number(q?.year)}:${Number(q?.question_no)}:${String(item?.label||'').toLowerCase()}`;
    const correction=KNOWN_ONE_BY_ONE_CORRECTIONS[key];
    if(!correction)return item;
    return {
      ...item,
      statement:correction.statement||item.statement,
      raw_statement:correction.statement||item.raw_statement,
      truth:typeof correction.truth==='boolean'?correction.truth:item.truth,
      correction_registry_version:KNOWN_CORRECTION_REGISTRY_VERSION,
      correction_key:key
    };
  }

  function deriveOneByOne(q){
    const out=[];
    // 相談事例・症例問題は、個々の選択肢だけでは前提条件を失うため一問一答化しない。
    if(isScenarioSourceQuestion(q)||isMultiColumnTableSource(q))return out;

    const statements=sourceStatements(q);
    const truth=truthFromPattern(q,statements);
    if(truth){
      for(const key of Object.keys(statements)){
        const rawStatement=statements[key];
        if(typeof truth[key]!=='boolean')continue;
        const statement=contextualizeStatement(q,rawStatement);
        out.push({question_id:`${q.question_id}_${key}`,year:q.year,question_no:q.question_no,chapter:q.chapter,statement,raw_statement:rawStatement,source_context:sourceTopic(q),truth:truth[key],source_question_id:q.question_id,label:key});
      }
      return out.map(item=>applyKnownOneByOneCorrection(item,q));
    }
    const prompt=cleanText(q.question_text,{stripQuestionNo:true}).split(/(?:１|1)[（(]?/)[0]||'';
    const choices=(q.choices||[]).map(cleanText);
    const answerIndex=Number(q.answer)-1;
    const uniqueChoices=new Set(choices);
    if(choices.length===5&&uniqueChoices.size===5&&answerIndex>=0&&answerIndex<5){
      if(/誤っているものはどれか/.test(prompt))choices.forEach((text,i)=>{if(text.length>=12){const statement=contextualizeStatement(q,text);out.push({question_id:`${q.question_id}_choice_${i+1}`,year:q.year,question_no:q.question_no,chapter:q.chapter,statement,raw_statement:text,source_context:sourceTopic(q),truth:i!==answerIndex,source_question_id:q.question_id,label:String(i+1)});}});
      else if(/正しいものはどれか/.test(prompt)&&!/組合せ/.test(prompt))choices.forEach((text,i)=>{if(text.length>=12){const statement=contextualizeStatement(q,text);out.push({question_id:`${q.question_id}_choice_${i+1}`,year:q.year,question_no:q.question_no,chapter:q.chapter,statement,raw_statement:text,source_context:sourceTopic(q),truth:i===answerIndex,source_question_id:q.question_id,label:String(i+1)});}});
    }
    return out.map(item=>applyKnownOneByOneCorrection(item,q));
  }

  function naturalStatementReasons(text){
    const t=cleanText(text),reasons=[];
    if(t.length<18||t.length>260)reasons.push('文字数不適合');
    if(!/[。！？]$/.test(t))reasons.push('文末不完全');
    if(/[�□■◆◇]|\*RRG|&OLQLFDO|3UDFWLFH|(?:[A-Z][a-z]?){5,}|[0-9A-Za-z]{10,}/.test(t))reasons.push('OCRノイズ');
    if(/(?:問|正しい組合せ|誤っているものはどれか|正しいものはどれか)$/.test(t))reasons.push('設問断片');
    if(/^[ぁ-んァ-ヶー\s]+$/.test(t))reasons.push('仮名断片');
    if(/^[^。！？]{0,12}[、：]$/.test(t))reasons.push('短い断片');

    // 参照対象が本文外にある指示語・製品呼称。
    if(/(?:本剤|本品|本製品|本製剤|当該医薬品|当該製剤|この医薬品|この製剤|その医薬品|その製剤|当該製品|同剤|同製剤|前記|上記|下記|前述|後述|このうち|これらのうち|次の成分|次の記述|この薬|その薬|このお薬|そのお薬|当該薬|この制酸薬|その制酸薬|この胃腸薬|その胃腸薬|この目薬|その目薬|このカプセル剤|そのカプセル剤)/.test(t))reasons.push('参照対象不明');

    if(/(?:陽性|陰性)界面活性/.test(t))reasons.push('OCR語句崩れ');
    if(/作用を(?!示す)[^、。！？]{1,12}示す/.test(t))reasons.push('語順崩れ');

    // 理由節・接続語だけが独立した文。
    if(/(?:ため|ので|ことから|ことにより|ことによって|おそれがあるため|可能性があるため)[。！？]$/.test(t))reasons.push('理由節断片');
    if(/^(?:そのため|このため|したがって|よって|また|なお)[、，]?/.test(t))reasons.push('接続語始まり');

    // 家族・相談事例の前提が抜けた記述。
    if(/(?:息子さん|娘さん|お子さん|子ども|子供|患者さん|相談者|購入者).*(?:服用|使用|お使い|使わせ|飲ませ|塗布|投与)/.test(t))reasons.push('事例前提欠落');
    if(/^(?:息子さん|娘さん|お子さん|子ども|子供|報告者|患者さん|相談者|購入者)(?:が|に|には|に対しては|に対して|へは|への)/.test(t))reasons.push('人物前提欠落');

    // 対象薬が分からない服用・使用上の注意。
    const drugWords=/(?:成分|薬|医薬品|製剤|製品|剤|漢方|鎮痛|解熱|かぜ|鼻炎|胃腸|制酸|瀉下|止瀉|鎮暈|鎮咳|去痰|外用|点眼|目薬|睡眠改善|禁煙補助|ビタミン|カルシウム|鉄|抗ヒスタミン|アドレナリン|カフェイン|アセトアミノフェン|イブプロフェン|ロキソプロフェン|ジフェンヒドラミン|プソイドエフェドリン|メチルエフェドリン|コデイン|ブロモバレリル尿素)/;
    const medicationAction=/(?:服用|使用|投与|塗布|点眼|貼付|吸入)/;
    if(/^(?:服用|使用|投与|塗布|点眼|貼付|吸入)(?:前|後|中|時|した後|すると)/.test(t) && !drugWords.test(t))reasons.push('対象薬不明');
    if(/^(?:服用後|使用後|投与後|塗布後|点眼後|貼付後|吸入後)[、，]/.test(t) && !drugWords.test(t))reasons.push('対象薬不明');
    if(/^(?:一定期間|一定回数|一定期間又は一定回数|しばらく|数日間).*(?:服用|使用)/.test(t))reasons.push('対象薬不明');
    if(/^(?:服用|使用)を(?:中止|継続)し/.test(t))reasons.push('対象薬不明');
    if(/^[^。！？]{0,28}(?:の診断を受けた人|治療中の人|妊婦|授乳婦|高齢者)は、?(?:服用|使用)前に/.test(t) && !drugWords.test(t))reasons.push('対象薬不明');
    if(/(?:専門家に相談すること|医師又は薬剤師に相談すること|受診すること)[。！？]$/.test(t) && medicationAction.test(t) && !drugWords.test(t))reasons.push('対象薬不明');
    if(/^(?:眠気|めまい|口渇|便秘|排尿困難|動悸|倦怠感|虚脱感)があらわれることがあります[。！？]$/.test(t))reasons.push('副作用対象不明');

    // 保存・使用指示だけを切り出したもの。
    if(/^(?:冷蔵庫内|直射日光の当たらない場所|湿気の少ない場所)で保管/.test(t))reasons.push('保存対象不明');

    // 報告制度の様式操作だけを問う低文脈・低学習価値の断片。
    if(/(?:報告様式|報告書|記入欄).*(?:すべて|全て|全部).*(?:記入|入力)/.test(t))reasons.push('報告様式断片');
    if(/^ウェブサイトに直接入力することによる電子的な報告/.test(t))reasons.push('報告手段断片');
    if(/^(?:インドメタシン|殺菌消毒薬|プレドニゾロン).*(?:使用を中止|使用するよう|勧める)/.test(t))reasons.push('事例選択肢断片');
    if(/^(?:紙の添付文書|添付文書に記載|製造販売業者の名称).*(?:廃止され|記載され|提供され)/.test(t) && !/について、/.test(t))reasons.push('制度文脈欠落');
    if(/^(?:医薬品との因果関係|安全対策上必要|保健衛生上の危害).*(?:報告|対象)/.test(t) && !/について、/.test(t))reasons.push('制度文脈欠落');
    if(/(?:相談を受け付けている|交付している|指定している|公表している|提供している|実施している|報告の対象となり得る)[。！？]$/.test(t) && !/(?:について、|センターは|大臣は|知事は|機構は|業者は|医薬関係者は)/.test(t))reasons.push('主体不明');

    if(/^[^。！？、]{1,24}(?:のため|であるため|なので)[、，]/.test(t))reasons.push('理由始まり');
    if(/^(?:これ|それ|このもの|そのもの|当該品)(?:は|を|に|が|で)/.test(t))reasons.push('指示語始まり');
    if(/^(?:この|その|当該)(?:お薬|薬|医薬品|製剤|製品|商品)/.test(t))reasons.push('参照対象不明');
    if(/(?:15歳未満|小児|乳幼児).*(?:使用できません|服用できません).*(?:娘さん|息子さん|お子さん)/.test(t))reasons.push('事例前提欠落');
    if(/アクリノール.*(?:創傷|患部).*(?:一般細\s*菌類|真菌類|ウイルス全般)/.test(t))reasons.push('表の列混入');
    if(/(?:黄色の色素|刺激性が低く).*(?:一般細\s*菌類|真菌類|ウイルス全般).*(?:患部|しみにくい)/.test(t))reasons.push('表の列混入');

    return [...new Set(reasons)];
  }

  function isNaturalStatement(text){
    return naturalStatementReasons(text).length===0;
  }

  const TOPIC_TERMS=[
    '添付文書','咀嚼剤','医薬品PLセンター','副作用等報告','医薬品副作用被害救済制度',
    '健康食品','特定保健用食品','機能性表示食品','配置販売業','店舗販売業','薬局',
    '一般用検査薬','妊娠検査薬','殺菌消毒成分','緊急安全性情報','安全性速報',
    '濫用等のおそれのある医薬品','要指導医薬品','第一類医薬品','指定第二類医薬品',
    'インターフェロン','間質性肺炎','偽アルドステロン症','無菌性髄膜炎','皮膚粘膜眼症候群',
    '中毒性表皮壊死融解症','肝機能障害','腎障害','アナフィラキシー'
  ];
  const INGREDIENT_TERMS=[
    'アセトアミノフェン','イブプロフェン','ロキソプロフェン','アスピリン','エテンザミド','イソプロピルアンチピリン',
    'カフェイン','無水カフェイン','ジフェンヒドラミン','クロルフェニラミン','クレマスチン','メキタジン',
    'プソイドエフェドリン','メチルエフェドリン','フェニレフリン','ナファゾリン','テトラヒドロゾリン',
    'コデイン','ジヒドロコデイン','デキストロメトルファン','ノスカピン','グアイフェネシン','ブロムヘキシン',
    'アンブロキソール','カルボシステイン','アセチルシステイン','グリチルリチン酸','カンゾウ','マオウ','ダイオウ',
    'スルファメトキサゾール','スルファジアジン','アクリノール','クロルヘキシジン','ベンザルコニウム',
    'セチルピリジニウム','ポビドンヨード','ヨウ素','イソプロピルメチルフェノール','トリクロロカルバニリド',
    'インドメタシン','フェルビナク','ケトプロフェン','ジクロフェナク','プレドニゾロン','ヒドロコルチゾン',
    'ニコチン','インターフェロン','hCG','ヒト絨毛性性腺刺激ホルモン','エストラジオール',
    'ピレンゼピン','ロートエキス','スコポラミン','ブチルスコポラミン','パパベリン','メチルベナクチジウム',
    '酸化マグネシウム','水酸化マグネシウム','炭酸カルシウム','炭酸水素ナトリウム','アルジオキサ',
    'スクラルファート','セトラキサート','テプレノン','ゲファルナート','ビサコジル','センノシド','ピコスルファート',
    'ロペラミド','タンニン酸アルブミン','次硝酸ビスマス','ベルベリン','木クレオソート'
  ];
  const KAMPO_TERMS=[
    '葛根湯','麻黄湯','小青竜湯','麦門冬湯','柴胡桂枝湯','小柴胡湯','大柴胡湯','半夏厚朴湯',
    '五苓散','防風通聖散','大黄甘草湯','乙字湯','芍薬甘草湯','加味逍遙散','当帰芍薬散','桂枝茯苓丸',
    '補中益気湯','十全大補湯','八味地黄丸','牛車腎気丸','六味丸','猪苓湯','黄連解毒湯','抑肝散',
    '釣藤散','呉茱萸湯','苓桂朮甘湯','温清飲','消風散','荊芥連翹湯','清上防風湯','防已黄耆湯'
  ];
  // 同じ知識IDでなくても、学習上ほぼ同じ題材に見える問題をまとめる近接カテゴリ。
  // 1セット内の重複を禁止し、120問全体でも上限を設ける。
  const SEMANTIC_TOPIC_GROUPS=[
    ['プラセボ効果',['プラセボ','偽薬効果','暗示効果']],
    ['乗物酔い',['乗物酔い','乗り物酔い','動揺病','メクリジン','ジフェニドール','スコポラミン']],
    ['抗ヒスタミン成分',['抗ヒスタミン','クロルフェニラミン','ジフェンヒドラミン','クレマスチン','カルビノキサミン']],
    ['解熱鎮痛成分',['解熱鎮痛','アセトアミノフェン','イブプロフェン','アスピリン','エテンザミド','イソプロピルアンチピリン']],
    ['鎮咳成分',['鎮咳','デキストロメトルファン','ジヒドロコデイン','ノスカピン','チペピジン']],
    ['去痰成分',['去痰','ブロムヘキシン','カルボシステイン','グアイフェネシン','エチルシステイン']],
    ['制酸・胃粘膜保護',['制酸','胃粘膜保護','炭酸水素ナトリウム','スクラルファート','セトラキサート','テプレノン','ゲファルナート']],
    ['瀉下成分',['瀉下','便秘薬','センノシド','ビサコジル','ピコスルファート','酸化マグネシウム']],
    ['止瀉成分',['止瀉','下痢止め','ロペラミド','タンニン酸アルブミン','次硝酸ビスマス','ベルベリン','木クレオソート']],
    ['一般用検査薬',['一般用検査薬','妊娠検査薬','尿糖・尿タンパク検査薬','尿糖検査薬','尿タンパク検査薬']],
    ['医薬品販売制度',['要指導医薬品','第一類医薬品','第1類医薬品','第二類医薬品','第2類医薬品','第三類医薬品','第3類医薬品','指定第二類','指定第2類']],
    ['医薬品広告',['広告','誇大広告','虚偽広告','承認前医薬品']],
    ['副作用救済制度',['副作用被害救済制度','医薬品副作用被害救済制度','救済給付']],
    ['添付文書・安全性情報',['添付文書','使用上の注意','安全性情報','緊急安全性情報','安全性速報']],
    ['濫用等のおそれのある医薬品',['濫用等のおそれ','指定濫用防止','頻回購入','若年者確認']]
  ];
  function normalizedTopicKey(v){return cleanText(v).normalize('NFKC').replace(/[\s　、。・（）()「」『』]/g,'').replace(/(?:に関する|について|の記述|次の記述)$/g,'')}
  function canonicalIngredientName(value){
    return String(value??'').replace(/(?:塩酸塩|臭化物|硫酸塩|硝酸塩|マレイン酸塩|フマル酸塩|クエン酸塩|リン酸塩|ナトリウム|カリウム|カルシウム)$/,'');
  }
  function topicKeys(q){
    const text=`${q.source_context||''} ${q.statement||q.question_text||''}`.normalize('NFKC'),keys=new Set();
    for(const term of TOPIC_TERMS)if(text.includes(term))keys.add(`term:${term}`);
    for(const term of KAMPO_TERMS)if(text.includes(term))keys.add(`kampo:${term}`);
    for(const term of INGREDIENT_TERMS)if(text.includes(term))keys.add(`ingredient:${canonicalIngredientName(term)}`);
    for(const [group,terms] of SEMANTIC_TOPIC_GROUPS)if(terms.some(term=>text.includes(term)))keys.add(`group:${group}`);
    for(const m of text.matchAll(/[一-龯ァ-ヶー]{2,14}(?:湯|散|丸|飲|膏)(?!剤)/g))keys.add(`kampo:${m[0]}`);
    for(const m of text.matchAll(/[一-龯ァ-ヶー]{3,24}(?:塩酸塩|臭化物|硫酸塩|硝酸塩|マレイン酸塩|フマル酸塩|クエン酸塩|リン酸塩|ナトリウム|カリウム|カルシウム)/g)){
      const name=canonicalIngredientName(m[0]);
      if(name.length>=3)keys.add(`ingredient:${name}`);
    }
    const ctx=normalizedTopicKey(q.source_context||'');
    if(ctx&&ctx.length>=3&&ctx.length<=32&&!/^(?:次|記述|正誤|組合せ)$/.test(ctx))keys.add(`context:${ctx}`);
    if(q.source_question_id)keys.add(`source:${q.source_question_id}`);
    else if(q.question_id)keys.add(`source:${q.question_id}`);
    return [...keys];
  }
  function hasTopicConflict(q,set){return topicKeys(q).some(k=>!k.startsWith('source:')&&set.has(k))}
  function addTopicKeys(q,set){topicKeys(q).filter(k=>!k.startsWith('source:')).forEach(k=>set.add(k))}
  function sharedTopicKeys(a,b){
    const A=new Set(topicKeys(a));
    return topicKeys(b).filter(k=>A.has(k));
  }
  function exceedsGlobalTopicLimit(candidate,selectedQuestions){
    const keys=topicKeys(candidate).filter(k=>!k.startsWith('source:'));
    for(const key of keys){
      const limit=(key.startsWith('ingredient:')||key.startsWith('kampo:')||key.startsWith('term:'))?1:key.startsWith('group:')?2:2;
      let used=0;
      for(const q of selectedQuestions)if(topicKeys(q).includes(key))used++;
      if(used>=limit)return true;
    }
    return false;
  }

  function normalizeSimilarityText(value){
    return cleanText(value)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/(?:である|とされる|ことがある|場合がある|こととされている|こととされる)/g,'')
      .replace(/(?:ではない|ない|なく|ず|誤り|誤っている|正しい|適切|不適切)/g,'')
      .replace(/[\s　、。！？「」『』（）()【】［］・:：;；,，.．―—ー－]/g,'');
  }
  function ngramSet(text,n=3){const set=new Set();for(let i=0;i<=text.length-n;i++)set.add(text.slice(i,i+n));return set;}
  function diceSimilarity(a,b,n=3){
    const x=normalizeSimilarityText(a),y=normalizeSimilarityText(b);
    if(!x||!y)return 0;
    if(x===y)return 1;
    if(Math.min(x.length,y.length)>=18&&(x.includes(y)||y.includes(x)))return Math.min(x.length,y.length)/Math.max(x.length,y.length);
    const A=ngramSet(x,n),B=ngramSet(y,n);if(!A.size||!B.size)return 0;
    let common=0;for(const v of A)if(B.has(v))common++;
    return (2*common)/(A.size+B.size);
  }
  function isNearDuplicateOneByOne(candidate,selectedQuestions){
    if(exceedsGlobalTopicLimit(candidate,selectedQuestions))return true;
    const c=cleanText(candidate.statement);
    for(const prev of selectedQuestions){
      if(candidate.source_question_id&&prev.source_question_id===candidate.source_question_id)return true;
      const p=cleanText(prev.statement);
      const sim=diceSimilarity(c,p,3);
      if(sim>=0.62)return true;
      const c2=normalizeSimilarityText(c),p2=normalizeSimilarityText(p);
      if(Math.min(c2.length,p2.length)>=24){
        const shorter=c2.length<=p2.length?c2:p2,longer=c2.length<=p2.length?p2:c2;
        if(longer.includes(shorter)&&shorter.length/longer.length>=0.68)return true;
      }
    }
    return false;
  }
  function isStructuralDuplicateOneByOne(candidate,selectedQuestions){
    // 候補不足時の最終防衛線。題材・成分カテゴリの上限はここでは緩和し、
    // 同一元問題と文章上ほぼ同一の記述だけを除外する。
    const c=cleanText(candidate.statement);
    for(const prev of selectedQuestions){
      if(candidate.source_question_id&&prev.source_question_id===candidate.source_question_id)return true;
      const p=cleanText(prev.statement);
      const sim=diceSimilarity(c,p,3);
      if(sim>=0.62)return true;
      const c2=normalizeSimilarityText(c),p2=normalizeSimilarityText(p);
      if(Math.min(c2.length,p2.length)>=24){
        const shorter=c2.length<=p2.length?c2:p2,longer=c2.length<=p2.length?p2:c2;
        if(longer.includes(shorter)&&shorter.length/longer.length>=0.68)return true;
      }
    }
    return false;
  }

  function isNearDuplicateExam(candidate,selectedQuestions){
    if(exceedsGlobalTopicLimit(candidate,selectedQuestions))return true;
    const c=questionSemanticText(candidate);
    for(const prev of selectedQuestions){
      if(candidate.question_id===prev.question_id)return true;
      const sim=diceSimilarity(c,questionSemanticText(prev),3);
      if(sim>=0.68)return true;
    }
    return false;
  }
  function buildOneByOnePool(questions){return questions.flatMap(deriveOneByOne).filter(x=>isNaturalStatement(x.statement))}
  function toOneByOneQuestion(q,no){
    const answer=q.truth?'○':'×';
    const dbExp=explanationForStatement(q.source_question_id,q.label);
    const generatedShort=conciseOneByOneExplanation(q.statement,q.truth);
    const generatedDetailed=detailedOneByOneExplanation(q.statement,q.truth,generatedShort);
    const short=dbExp?.shortExplanation||generatedShort;
    const detailed=dbExp?.detailedExplanation||generatedDetailed;
    const tkdbKnowledgeId=dbExp?.knowledgeId||null;
    return {
      no,chapter:q.chapter,theme:`東京都${q.year}年度`,knowledge_id:q.question_id,tkdb_knowledge_id:tkdbKnowledgeId,
      source:`過去問（東京都${q.year}年度 問${q.question_no}）`,source_question_id:q.source_question_id||'',source_statement_id:q.question_id,
      topic_keys:topicKeys(q).filter(k=>!k.startsWith('source:')),answer,text:cleanText(q.statement),
      shortExplanation:short,explanation:detailed,correction:dbExp?.correction||null,
      explanationStatus:dbExp?.evidence?.status==='auto_matched'?'usable':'fallback',evidence:dbExp?.evidence||null,
      category:'one_by_one',category_label:'一問一答'
    };
  }

  function pickByDistribution(pool,distribution,random,blocked,selected,selectedQuestions=[],duplicateGuard=null,topicSet=null){const picked=[];for(const [chapter,count] of Object.entries(distribution))picked.push(...pick(pool.filter(q=>q.chapter===chapter),count,random,blocked,selected,selectedQuestions,duplicateGuard,topicSet));return picked}
  function makeSet({pool,distribution,count,id,title,note,random,blocked,selected,mapper,selectedQuestions=[],duplicateGuard=null}){
    const topicSet=new Set(),picked=[];
    const learn=learningMap(),generated=generatedCounts();
    for(const [chapter,required] of Object.entries(distribution)){
      const chapterPicked=pick(pool.filter(q=>q.chapter===chapter),required,random,blocked,selected,selectedQuestions,duplicateGuard,topicSet);
      picked.push(...chapterPicked);
      if(chapterPicked.length>=required)continue;

      // 題材分散を優先しつつ、問題不足時は同一章内だけで段階的に緩和する。
      const candidates=[...pool.filter(q=>q.chapter===chapter)]
        .sort((a,b)=>priorityScore(b,random,learn,generated)-priorityScore(a,random,learn,generated));
      for(const allowRecent of [false,true]){
        for(const q of candidates){
          if(chapterPicked.length>=required)break;
          if(selected.has(q.question_id))continue;
          const isReview=((learn.get(String(q.question_id))?.wrongCount||0)>0||(learn.get(String(q.question_id))?.uncertainCount||0)>0);
          if(!allowRecent&&blocked.has(q.question_id)&&!isReview)continue;
          const hardDuplicate=duplicateGuard===isNearDuplicateOneByOne
            ?isStructuralDuplicateOneByOne(q,selectedQuestions)
            :(duplicateGuard&&duplicateGuard(q,selectedQuestions));
          if(hardDuplicate)continue;
          chapterPicked.push(q);picked.push(q);selected.add(q.question_id);selectedQuestions.push(q);addTopicKeys(q,topicSet);
        }
        if(chapterPicked.length>=required)break;
      }
      if(chapterPicked.length<required)throw new Error(`${title}の${chapter}を${required}問確保できませんでした（確保${chapterPicked.length}問）`);
    }
    if(picked.length!==count)throw new Error(`${title}の問題数が不正です（${picked.length}/${count}問）`);
    return {id,title,note,questions:shuffle(picked,random).map((q,i)=>mapper(q,i+1))}
  }

  const KIND_LABELS={normal:'通常',practice:'練習',development:'開発'};
  function generatedTitle(date,kind,sequence=1){const d=date.replace(/-/g,'/'),n=Math.max(1,Number(sequence)||1);if(kind==='practice')return `${d}（練習${n===1?'':n}）`;if(kind==='development')return `${d}（開発${n===1?'':n}）`;return n===1?d:`${d}（${n}）`}
  function auditGeneratedResult(result,mode){
    const issues=[],warnings=[];
    const all=result.sets.flatMap(s=>s.questions.map(q=>({setId:s.id,q})));
    const ids=new Set();
    for(const {setId,q} of all){
      const id=String(q.knowledge_id||'');
      if(!id)issues.push(`${setId}:knowledge_id欠落`);
      if(ids.has(id))issues.push(`${setId}:knowledge_id重複:${id}`);
      ids.add(id);
      if(!cleanText(q.text||''))issues.push(`${setId}:${id}:本文欠落`);
      if(mode==='one_by_one'&&naturalStatementReasons(q.text||'').length)issues.push(`${setId}:${id}:本文品質:${naturalStatementReasons(q.text||'').join('/')}`);
    }
    if(mode==='one_by_one'){
      for(const set of result.sets){
        const count={};for(const q of set.questions)count[q.chapter]=(count[q.chapter]||0)+1;
        for(const [chapter,expected] of Object.entries(DISTRIBUTIONS.one_by_one))if((count[chapter]||0)!==expected)issues.push(`${set.id}:${chapter}=${count[chapter]||0}（期待${expected}）`);
        const topicCount={};for(const q of set.questions)for(const k of (q.topic_keys||[]))topicCount[k]=(topicCount[k]||0)+1;
        for(const [k,n] of Object.entries(topicCount))if(n>1)warnings.push(`${set.id}:題材分散を緩和:${k}=${n}`);
      }
    }
    return {ok:issues.length===0,issueCount:issues.length,warningCount:warnings.length,issues,warnings};
  }

  function saveHistory(result,mode,kind){const ids=result.sets.flatMap(s=>s.questions.map(q=>q.knowledge_id));const rows=history();rows.push({dayId:result.id,date:result.date.replace(/\//g,'-'),resultTitle:result.title,category:result.category,mode,kind,questionIds:ids,createdAt:new Date().toISOString()});localStorage.setItem(HISTORY_KEY,JSON.stringify(rows.slice(-100)))}
  function generate({questions,date,dayId,title,mode='exam_style',kind='normal',sequence=1}){
    const actualTitle=title||generatedTitle(date,kind,sequence);
    const random=rng(hashSeed(`${date}|${dayId}|${mode}|${kind}|${questions.length}`)),blocked=recentIds(mode,3),selected=new Set();
    let result;
    if(mode==='one_by_one'){
      const derived=questions.flatMap(deriveOneByOne),pool=derived.filter(x=>isNaturalStatement(x.statement)),sets=[],selectedQuestions=[];
      if(pool.length<120)throw new Error(`一問一答の使用可能問題が不足しています（${pool.length}問）`);
      for(let i=1;i<=4;i++)sets.push(makeSet({pool,distribution:DISTRIBUTIONS.one_by_one,count:30,id:`${dayId}-set-${i}`,title:`第${i}セット`,note:`全120問中 ${i}/4`,random,blocked,selected,mapper:toOneByOneQuestion,selectedQuestions,duplicateGuard:isNearDuplicateOneByOne}));
      result={id:dayId,title:actualTitle,date:date.replace(/-/g,'/'),category:'one_by_one',category_label:'一問一答',mode:'one_by_one',kind,sets,qualityFilter:{derivedCount:derived.length,usableCount:pool.length,excludedCount:derived.length-pool.length}};
    }else if(mode==='practice60'){
      const examPool=questions.filter(isUsableExamQuestion),selectedQuestions=[];
      const full=makeSet({pool:examPool,distribution:DISTRIBUTIONS.practice60,count:60,id:`${dayId}-practice60`,title:'総合演習 60問',note:'全5章を本番比率で総合演習',random,blocked,selected,mapper:toExamQuestion,selectedQuestions,duplicateGuard:isNearDuplicateExam});
      result={id:dayId,title:actualTitle,date:date.replace(/-/g,'/'),category:'practice60',category_label:'総合演習60問',mode:'practice60',kind,sets:[{id:`${dayId}-practice60-front`,title:'前半 30問',note:'総合演習60問の前半',questions:full.questions.slice(0,30)},{id:`${dayId}-practice60-back`,title:'後半 30問',note:'総合演習60問の後半',questions:full.questions.slice(30)}]};
    }else{
      const examPool=questions.filter(isUsableExamQuestion),selectedQuestions=[];
      const front=makeSet({pool:examPool,distribution:DISTRIBUTIONS.exam_am,count:60,id:`${dayId}-front`,title:'前半 60問',note:'第1章20・第2章20・第4章20',random,blocked,selected,mapper:toExamQuestion,selectedQuestions,duplicateGuard:isNearDuplicateExam});
      const back=makeSet({pool:examPool,distribution:DISTRIBUTIONS.exam_pm,count:60,id:`${dayId}-back`,title:'後半 60問',note:'第3章40・第5章20',random,blocked,selected,mapper:toExamQuestion,selectedQuestions,duplicateGuard:isNearDuplicateExam});
      result={id:dayId,title:actualTitle,date:date.replace(/-/g,'/'),category:'exam_style',category_label:'本番形式120問',mode:'exam_style',kind,sets:[front,back]};
    }
    result.schemaVersion="2.1";result.engineVersion="2.1.3";result.embeddedAnswerData=true;result.generation_kind=kind;result.generation_kind_label=KIND_LABELS[kind]||kind;result.generation_sequence=Math.max(1,Number(sequence)||1);result.generated_at=new Date().toISOString();result.correctionRegistryVersion=KNOWN_CORRECTION_REGISTRY_VERSION;const lm=learningMap(),gc=generatedCounts(),allIds=result.sets.flatMap(s=>s.questions.map(q=>String(q.knowledge_id||"")));result.selectionPolicy={priority:"exam_distribution > unseen > light_weakness_bonus",topicPolicy:"same exact topic once per set and once per 120; nearby semantic category at most twice per 120",unseenSelected:allIds.filter(id=>Math.max(Number(lm.get(id)?.shownCount)||0,gc.get(id)||0)===0).length,reviewSelected:allIds.filter(id=>(lm.get(id)?.wrongCount||0)>0||(lm.get(id)?.unknownCount||0)>0||(lm.get(id)?.uncertainCount||0)>0).length,topicDuplicateLimit:"same topic once per set"};result.generationAudit=auditGeneratedResult(result,mode);if(!result.generationAudit.ok)throw new Error(`生成後品質検査に失敗しました: ${result.generationAudit.issues.slice(0,5).join(" / ")}`);saveHistory(result,mode,kind);return result;
  }

  window.TouhanGenerator={setExplanationData,generate,buildOneByOnePool,DISTRIBUTIONS,HISTORY_KEY,LEARNING_KEY,KIND_LABELS,generatedTitle,cleanText,stripSourceQuestionNumber,formatExamQuestionText,formatExamChoiceText,extractLetterStatements,isUsableExamQuestion,isNaturalStatement,naturalStatementReasons,isScenarioSourceQuestion,isMultiColumnTableSource,sourceTopic,contextualizeStatement,diceSimilarity,isNearDuplicateOneByOne,isNearDuplicateExam,sourceStatements,questionSemanticText,normalizeCorrespondenceStatement,topicKeys,auditGeneratedResult};
})();
(function(){
  window.__TOUHAN_ENGINE_SCRIPT_LOADED__=true;
  let rawDb=null, report=null, generated=null, tkdbDb=null;
  const TKDB_IDB_NAME='touhan_engine_data_v2';
  const TKDB_IDB_VERSION=1;
  const STORE_CONTENT='content';
  const STORE_HANDLES='handles';
  const TKDB_CONTENT_KEY='active_tkdb';
  const HANDLE_LEARNING='learning_handle';
  const HANDLE_TKDB='tkdb_handle';
  const META_KEY='touhan.engine.data.meta.v2';
  const supportsFileHandles=typeof window.showOpenFilePicker==='function';
  const $=id=>document.getElementById(id);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function getMeta(){try{return JSON.parse(localStorage.getItem(META_KEY)||'{}')}catch{return{}}}
  function patchMeta(patch){const next={...getMeta(),...patch};localStorage.setItem(META_KEY,JSON.stringify(next));return next}
  function normalizeTkdbObject(input){
    const seen=new Set();
    function unwrap(o,depth=0){
      if(!o||typeof o!=='object'||Array.isArray(o)||depth>5||seen.has(o))return null;
      seen.add(o);
      if(o.records&&typeof o.records==='object'&&!Array.isArray(o.records))return o;
      const candidates=[o.tkdb,o.runtimeTkdb,o.activeTkdb,o.payload,o.data?.tkdb,o.data?.runtimeTkdb,o.data];
      for(const c of candidates){const found=unwrap(c,depth+1);if(found)return found}
      return null;
    }
    const tkdb=unwrap(input);
    if(!tkdb)return null;
    if(!tkdb.questionMap||typeof tkdb.questionMap!=='object'||Array.isArray(tkdb.questionMap)){
      const grouped={};
      for(const [sourceId,r] of Object.entries(tkdb.records||{})){
        const m=String(sourceId).match(/^(tokyo_\d{4}_\d{3})_([a-z])$/i);
        if(!m)continue;
        const qid=m[1],label=m[2].toLowerCase(),idx=label.charCodeAt(0)-97;
        if(!grouped[qid])grouped[qid]={questionId:qid,knowledgeIds:[],chapter:r?.chapter||'',officialTopicId:r?.officialTopicId||r?.topicId||''};
        grouped[qid].knowledgeIds[idx]=String(r?.tkdbKnowledgeId||r?.knowledgeId||sourceId);
        if(!grouped[qid].chapter&&r?.chapter)grouped[qid].chapter=r.chapter;
      }
      for(const q of Object.values(grouped))q.knowledgeIds=q.knowledgeIds.filter(Boolean);
      tkdb.questionMap=grouped;
    }
    return tkdb;
  }
  function validTkdbObject(o){const t=normalizeTkdbObject(o);return !!(t&&Object.keys(t.records||{}).length)}
  function getKnowledge(id){return tkdbDb?.records?.[String(id)]||null}
  function getQuestionKnowledge(questionId){const qm=tkdbDb?.questionMap?.[String(questionId)];if(!qm)return[];return (qm.knowledgeIds||[]).map((id,index)=>({id:String(id),label:String.fromCharCode(97+index),record:getKnowledge(id)}))}
  function tkdbToExplanationRows(input){
    const tkdb=normalizeTkdbObject(input);
    if(!tkdb||!Object.keys(tkdb.records||{}).length){
      const keys=input&&typeof input==='object'&&!Array.isArray(input)?Object.keys(input).slice(0,12).join(', '):typeof input;
      throw new Error(`TKDB形式が不正です（recordsを確認できません。検出キー: ${keys||'なし'}）`);
    }
    if(!Object.keys(tkdb.questionMap||{}).length)throw new Error('TKDBの問題対応表をrecordsから復元できません');
    tkdbDb=tkdb;
    const byCanonical=new Map();
    for(const [sourceId,r] of Object.entries(tkdb.records)){
      const id=String(r?.tkdbKnowledgeId||sourceId||'').trim();
      if(!id)continue;
      if(!byCanonical.has(id))byCanonical.set(id,[]);
      byCanonical.get(id).push({sourceId,...r});
    }
    const rows=[];
    for(const [questionId,qm] of Object.entries(tkdb.questionMap)){
      const statements=(qm.knowledgeIds||[]).map((canonicalId,i)=>{
        const expected=`${questionId}_${String.fromCharCode(97+i)}`;
        const candidates=byCanonical.get(String(canonicalId))||[];
        const r=candidates.find(x=>x.sourceId===expected)||candidates.find(x=>String(x.sourceId).startsWith(questionId+'_'))||candidates[0]||{};
        return {label:String.fromCharCode(97+i),knowledgeId:String(canonicalId),statement:r.canonicalStatement||r.statement||'',correctAnswer:r.correctAnswer||'',shortExplanation:r.shortExplanation||'',detailedExplanation:r.detailedExplanation||null,correction:r.correction||null,mistakePoints:r.mistakePoints||[],evidence:r.evidence||null,verificationStatus:r.verificationStatus||'',verificationReason:r.verificationReason||'',safeToDisplayDetailedExplanation:!!r.safeToDisplayDetailedExplanation,tkdbKnowledgeId:String(canonicalId),sourceKnowledgeId:r.sourceId||expected};
      });
      rows.push({questionId,chapter:qm.chapter||'',topicId:qm.officialTopicId||'',statements});
    }
    if(!rows.length)throw new Error('TKDBのquestionMapが空です');
    return rows;
  }

  function openDataDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(TKDB_IDB_NAME,TKDB_IDB_VERSION);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE_CONTENT))db.createObjectStore(STORE_CONTENT);if(!db.objectStoreNames.contains(STORE_HANDLES))db.createObjectStore(STORE_HANDLES)};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
  async function idbPut(store,key,value){const db=await openDataDb();try{await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}finally{db.close()}}
  async function idbGet(store,key){try{const db=await openDataDb();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readonly');const req=tx.objectStore(store).get(key);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error)})}finally{db.close()}}catch{return null}}
  async function idbDelete(store,key){try{const db=await openDataDb();try{await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).delete(key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}finally{db.close()}}catch{}}
  async function clearExternalData(){await Promise.all([idbDelete(STORE_CONTENT,TKDB_CONTENT_KEY),idbDelete(STORE_HANDLES,HANDLE_TKDB),idbDelete(STORE_HANDLES,HANDLE_LEARNING)]);localStorage.removeItem(META_KEY)}

  async function handlePermission(handle,request=false){if(!handle)return false;const opts={mode:'read'};if((await handle.queryPermission(opts))==='granted')return true;if(request&&(await handle.requestPermission(opts))==='granted')return true;return false}
  async function readJsonHandle(handle,request=false){if(!await handlePermission(handle,request))throw new Error('ファイルの読み取り権限がありません');const file=await handle.getFile();return {file,json:JSON.parse(await file.text())}}
  async function pickJsonHandle(){const [handle]=await window.showOpenFilePicker({multiple:false,types:[{description:'JSON',accept:{'application/json':['.json']}}]});return handle}

  function setStatus(text,type=''){const e=$('generatorStatus');e.textContent=text;e.className='status-box '+type}
  function today(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
  function modeSlug(){const m=$('genMode').value;return m==='one_by_one'?'onebyone':m==='practice60'?'practice60':'exam120'}
  function syncMeta(){const n=Math.max(1,Number($('genRound').value)||1),d=$('genDate').value||today(),kind=$('genKind').value;$('genDayId').value=`study-${d.replaceAll('-','')}-${modeSlug()}-${kind}-${String(n).padStart(2,'0')}`;$('genTitle').value=TouhanGenerator.generatedTitle(d,kind,n);const m=$('genMode').value;$('generateDailyBtn').textContent=m==='one_by_one'?'一問一答を生成':m==='practice60'?'総合演習を生成':'本番問題を生成';$('downloadSetsBtn').textContent=m==='one_by_one'?'4セット個別保存':'前半・後半を個別保存'}
  function setDataVisual(kind,{ready=false,warning=false,status='',meta='',detail=''}){const cap=kind[0].toUpperCase()+kind.slice(1);const item=$(`${kind}DataItem`),dot=$(`${kind}StatusDot`),statusEl=$(`${kind}CompactStatus`),metaEl=$(`${kind}MetaStatus`),detailEl=$(`${kind}Detail`);if(item)item.className=`data-item${ready?' is-ready':warning?' is-warning':''}`;if(dot)dot.className=`status-dot${ready?' ready':warning?' warning':''}`;if(statusEl){statusEl.textContent=status;statusEl.className=`data-status${ready?' ready':''}`};if(metaEl)metaEl.textContent=meta;if(detailEl)detailEl.textContent=detail||status}
  function learningState(){try{return JSON.parse(localStorage.getItem(TouhanGenerator.LEARNING_KEY)||'null')}catch{return null}}
  function updateCompactStatuses(){
    const state=learningState(),history=(()=>{try{return JSON.parse(localStorage.getItem(TouhanGenerator.HISTORY_KEY)||'[]')}catch{return[]}})(),meta=getMeta();
    if(state?.questions){const wrong=state.questions.filter(x=>(x.wrongCount||0)>0).length,unknown=state.questions.filter(x=>(x.unknownCount||0)>0).length;setDataVisual('learning',{ready:true,status:`${state.questions.length}知識・要復習${wrong+unknown}`,meta:meta.learning?.name?`${meta.learning.name}｜${formatTime(meta.learning.at)}`:`保存済み｜履歴${history.length}`,detail:`${state.questions.length}知識 / 誤答${wrong} / 不明${unknown}`})}else setDataVisual('learning',{warning:true,status:'未読込',meta:supportsFileHandles?'JSON選択後は次回から自動再読込':'学習状況JSONを選択してください',detail:'未読込'});
    const count=Object.keys(tkdbDb?.records||{}).length,version=tkdbDb?.tkdbVersion||'';
    if(tkdbDb)setDataVisual('tkdb',{ready:true,status:meta.tkdb?.name?`${count}知識・外部`:`${count}知識・内蔵`,meta:meta.tkdb?.name?`${meta.tkdb.name}${version?` / ${version}`:''}｜${formatTime(meta.tkdb.at)}`:`data/tkdb.json${version?` / ${version}`:''}`,detail:`${count}知識 / ${Object.keys(tkdbDb.questionMap||{}).length}問対応`});
    if($('masterDetail'))$('masterDetail').textContent=rawDb?`${rawDb.questions?.length||0}問`:'未読込';
    if($('refreshLearningBtn'))$('refreshLearningBtn').disabled=!supportsFileHandles||!meta.learning?.handleStored;
    if($('refreshTkdbBtn'))$('refreshTkdbBtn').disabled=!supportsFileHandles||!meta.tkdb?.handleStored;
  }
  function formatTime(value){if(!value)return'';const d=new Date(value);if(!Number.isFinite(d.getTime()))return'';return new Intl.DateTimeFormat('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(d)}

  async function applyTkdb(obj,meta=null,persist=false){const normalized=normalizeTkdbObject(obj);const rows=tkdbToExplanationRows(normalized||obj);TouhanGenerator.setExplanationData(rows);if(persist)await idbPut(STORE_CONTENT,TKDB_CONTENT_KEY,tkdbDb);if(meta)patchMeta({tkdb:{...meta,version:tkdbDb?.tkdbVersion||meta?.version||''}});updateCompactStatuses();return rows.reduce((n,q)=>n+(q.statements?.length||0),0)}
  async function loadBundled(){
    setStatus('問題DB・TKDBを読み込んでいます…');
    const masterRes=await fetch('./data/tokyo_master.json',{cache:'no-store'});if(!masterRes.ok)throw new Error(`問題DB読込失敗: ${masterRes.status}`);rawDb=await masterRes.json();
    let active=null,statementCount=0;
    const handle=await idbGet(STORE_HANDLES,HANDLE_TKDB);
    if(handle){try{const r=await readJsonHandle(handle,false);statementCount=await applyTkdb(r.json,{name:r.file.name,version:r.json.tkdbVersion||'',at:new Date().toISOString(),handleStored:true},true);active='handle'}catch(e){console.warn('TKDBファイルの自動再読込をスキップ',e)}}
    if(!active){const cached=await idbGet(STORE_CONTENT,TKDB_CONTENT_KEY);if(cached){try{statementCount=await applyTkdb(cached,null,false);active='cache'}catch(e){console.warn('保存TKDBを使用できません',e);await idbDelete(STORE_CONTENT,TKDB_CONTENT_KEY)}}}
    if(!active){const res=await fetch('./data/tkdb.json',{cache:'no-store'});if(!res.ok)throw new Error(`TKDB読込失敗: ${res.status}`);statementCount=await applyTkdb(await res.json(),null,false)}
    await tryAutoReloadLearning();
    setStatus(`DB読込完了：${rawDb.questions?.length||0}問／TKDB ${statementCount}記述`,'ok');updateCompactStatuses();return rawDb;
  }
  async function tryAutoReloadLearning(){const handle=await idbGet(STORE_HANDLES,HANDLE_LEARNING);if(!handle)return false;try{const r=await readJsonHandle(handle,false);await applyLearning(r.json,{name:r.file.name,at:new Date().toISOString(),handleStored:true});return true}catch(e){console.warn('学習状況の自動再読込をスキップ',e);return false}}
  async function ensureDb(){if(rawDb&&tkdbDb)return rawDb;return loadBundled()}
  function renderValidation(r){$('validationSummary').innerHTML=[['総数',r.total],['使用可能',r.validCount],['除外',r.invalidCount],['ID重複',r.duplicateIds.length]].map(([k,v])=>`<div class="summary-item">${esc(k)}<b>${esc(v)}</b></div>`).join('');$('validationDetails').textContent=r.invalid.slice(0,200).map(x=>`${x.id} (${x.year||'-'} 問${x.no||'-'}): ${x.reasons.join(' / ')}`).join('\n')||'除外なし'}
  async function validate(){await ensureDb();report=TouhanValidator.validateDatabase(rawDb);renderValidation(report);setStatus(`品質検査完了：${report.validCount}/${report.total}問を使用可能`,'ok');return report}
  function renderGenerated(data){const qs=data.sets.flatMap(s=>s.questions),chapters={};qs.forEach(q=>chapters[q.chapter]=(chapters[q.chapter]||0)+1);$('generationSummary').innerHTML=[['セット',data.sets.length],['問題数',qs.length],...Object.entries(chapters)].map(([k,v])=>`<div class="summary-item">${esc(k)}<b>${esc(v)}</b></div>`).join('');$('generatedJson').value=JSON.stringify(data,null,2)}
  function download(name,obj){const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(u)}

  function normalizeLearningState(o){
    if(o?.type!=='touhan_learning_state')throw new Error('学習状況JSONではありません');
    if(Array.isArray(o.questions))return {...o,schemaVersion:o.schemaVersion||'1.2'};
    const answers=o?.data?.answers,wrongMeta=o?.data?.wrongMeta;if(!answers||typeof answers!=='object')throw new Error('学習状況JSONにquestionsまたはdata.answersがありません');
    const map=new Map(),ensure=id=>{id=String(id||'').trim();if(!id)return null;if(!map.has(id))map.set(id,{knowledgeId:id,shownCount:0,answeredCount:0,correctCount:0,wrongCount:0,uncertainCount:0,unknownCount:0,lastResult:'',lastAnsweredAt:''});return map.get(id)};
    for(const st of Object.values(answers)){if(!st||typeof st!=='object')continue;for(const r of (Array.isArray(st.questionResults)?st.questionResults:[])){const x=ensure(r?.knowledgeId);if(!x)continue;x.shownCount++;if(r.userAnswer)x.answeredCount++;if(r.userAnswer){if(r.isCorrect)x.correctCount++;else x.wrongCount++}if(r.wasUnsure)x.uncertainCount++;if(r.wasUnknown)x.unknownCount++;x.lastResult=r.isCorrect?(r.wasUnknown?'unknown':r.wasUnsure?'uncertain':'correct'):'wrong';const at=st.gradedAt||st.updated||'';if(at&&(!x.lastAnsweredAt||Date.parse(at)>Date.parse(x.lastAnsweredAt)))x.lastAnsweredAt=at}}
    if(wrongMeta&&typeof wrongMeta==='object')for(const [key,m] of Object.entries(wrongMeta)){if(!m||typeof m!=='object')continue;let id=String(m.questionKey||key||'').trim();if(!/^tokyo_\d{4}_\d{3}(?:_[a-z])?$/.test(id)){const ex=String(m.sourceExamId||''),no=Number(m.sourceNo),ym=ex.match(/tokyo[_-]?(20\d{2})/i);if(ym&&Number.isFinite(no))id=`tokyo_${ym[1]}_${String(no).padStart(3,'0')}`;else continue}const x=ensure(id);if(!x)continue;x.shownCount=Math.max(x.shownCount,Number(m.attempts)||0);x.answeredCount=Math.max(x.answeredCount,Number(m.attempts)||0);x.correctCount=Math.max(x.correctCount,Number(m.correctCount)||0);x.wrongCount=Math.max(x.wrongCount,Number(m.wrongCount)||0);x.uncertainCount=Math.max(x.uncertainCount,Number(m.unsureCount)||0);x.unknownCount=Math.max(x.unknownCount,Number(m.unknownCount)||0);if(m.lastResult)x.lastResult=String(m.lastResult);if(m.lastAnsweredAt&&(!x.lastAnsweredAt||Date.parse(m.lastAnsweredAt)>Date.parse(x.lastAnsweredAt)))x.lastAnsweredAt=m.lastAnsweredAt}
    const questions=[...map.values()];if(!questions.length)throw new Error('学習履歴からknowledgeIdを取得できません');return {type:'touhan_learning_state',schemaVersion:'1.3',generatedAt:o.createdAt||o.generatedAt||new Date().toISOString(),sourceAppVersion:o.appVersion||o.sourceAppVersion||'',priorityPolicy:'unseen > wrong_or_unknown > uncertain > seen',questionCount:questions.length,questions};
  }
  async function applyLearning(obj,meta=null){const state=normalizeLearningState(obj);localStorage.setItem(TouhanGenerator.LEARNING_KEY,JSON.stringify(state));if(meta)patchMeta({learning:meta});updateCompactStatuses();return state}
  async function importLearningFile(file){const state=await applyLearning(JSON.parse(await file.text()),{name:file.name,at:new Date().toISOString(),handleStored:false});setStatus(`学習状況を読み込みました：${state.questions.length}知識`,'ok')}
  async function importTkdbFile(file){const o=JSON.parse(await file.text()),count=await applyTkdb(o,{name:file.name,version:o.tkdbVersion||'',at:new Date().toISOString(),handleStored:false},true);report=null;setStatus(`TKDBを読み込みました：${Object.keys(tkdbDb?.records||{}).length}知識／${count}記述`,'ok')}
  async function chooseLearning(){if(!supportsFileHandles)return $('learningFile').click();const handle=await pickJsonHandle();const r=await readJsonHandle(handle,true);await idbPut(STORE_HANDLES,HANDLE_LEARNING,handle);const state=await applyLearning(r.json,{name:r.file.name,at:new Date().toISOString(),handleStored:true});setStatus(`学習状況を接続しました：${state.questions.length}知識`,'ok')}
  async function chooseTkdb(){if(!supportsFileHandles)return $('tkdbFile').click();const handle=await pickJsonHandle();const r=await readJsonHandle(handle,true);await idbPut(STORE_HANDLES,HANDLE_TKDB,handle);const count=await applyTkdb(r.json,{name:r.file.name,version:r.json.tkdbVersion||'',at:new Date().toISOString(),handleStored:true},true);report=null;setStatus(`TKDBを接続しました：${Object.keys(tkdbDb?.records||{}).length}知識／${count}記述`,'ok')}
  async function refreshLearning(request=true){const handle=await idbGet(STORE_HANDLES,HANDLE_LEARNING);if(!handle)throw new Error('再読込できる学習状況ファイルがありません');const r=await readJsonHandle(handle,request);const state=await applyLearning(r.json,{name:r.file.name,at:new Date().toISOString(),handleStored:true});setStatus(`学習状況を更新しました：${state.questions.length}知識`,'ok')}
  async function refreshTkdb(request=true){const handle=await idbGet(STORE_HANDLES,HANDLE_TKDB);if(!handle)throw new Error('再読込できるTKDBファイルがありません');const r=await readJsonHandle(handle,request);const count=await applyTkdb(r.json,{name:r.file.name,version:r.json.tkdbVersion||'',at:new Date().toISOString(),handleStored:true},true);report=null;setStatus(`TKDBを更新しました：${count}記述`,'ok')}

  window.TouhanTKDB={getKnowledge,getQuestionKnowledge,get version(){return tkdbDb?.tkdbVersion||''},get recordCount(){return Object.keys(tkdbDb?.records||{}).length}};

  document.addEventListener('DOMContentLoaded',()=>{
    $('genDate').value=today();syncMeta();$('genDate').addEventListener('change',syncMeta);$('genRound').addEventListener('input',syncMeta);$('genMode').addEventListener('change',syncMeta);$('genKind').addEventListener('change',syncMeta);
    $('loadDbBtn').onclick=()=>loadBundled().then(validate).catch(e=>setStatus(e.message,'err'));
    $('chooseMasterBtn').onclick=()=>$('masterFile').click();
    $('chooseLearningBtn').onclick=()=>chooseLearning().catch(e=>setStatus(`学習状況読込失敗：${e.message}`,'err'));
    $('chooseTkdbBtn').onclick=()=>chooseTkdb().catch(e=>setStatus(`TKDB読込失敗：${e.message}`,'err'));
    $('refreshLearningBtn').onclick=()=>refreshLearning(true).catch(e=>setStatus(`学習状況更新失敗：${e.message}`,'err'));
    $('refreshTkdbBtn').onclick=()=>refreshTkdb(true).catch(e=>setStatus(`TKDB更新失敗：${e.message}`,'err'));
    $('reloadDataBtn').onclick=async()=>{try{rawDb=null;report=null;await loadBundled();await validate();setStatus('データを再読込しました','ok')}catch(e){setStatus(`再読込失敗：${e.message}`,'err')}};
    $('resetDataBtn').onclick=async()=>{if(!confirm('外部TKDB・学習状況・ファイル接続を解除し、内蔵データへ戻しますか？'))return;await clearExternalData();localStorage.removeItem(TouhanGenerator.LEARNING_KEY);tkdbDb=null;rawDb=null;report=null;await loadBundled();await validate();setStatus('内蔵データへ戻しました','ok')};
    $('validateDbBtn').onclick=()=>validate().catch(e=>setStatus(e.message,'err'));
    $('masterFile').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;rawDb=JSON.parse(await f.text());report=null;updateCompactStatuses();setStatus(`ローカル問題DB読込完了：${rawDb.questions?.length||0}問`,'ok')}catch(err){setStatus(`問題DB読込失敗：${err.message}`,'err')}finally{e.target.value=''}};
    $('learningFile').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;await importLearningFile(f)}catch(err){setStatus(`学習状況読込失敗：${err.message}`,'err')}finally{e.target.value=''}};
    $('tkdbFile').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;await importTkdbFile(f)}catch(err){setStatus(`TKDB読込失敗：${err.message}`,'err')}finally{e.target.value=''}};
    updateCompactStatuses();
    $('generateDailyBtn').onclick=async()=>{try{if(!report)await validate();const mode=$('genMode').value;generated=TouhanGenerator.generate({questions:report.valid,date:$('genDate').value,dayId:$('genDayId').value.trim(),title:$('genTitle').value.trim(),mode,kind:$('genKind').value,sequence:Number($('genRound').value)||1});renderGenerated(generated);setStatus(`${mode==='one_by_one'?'一問一答':mode==='practice60'?'総合演習':'本番問題'}を生成しました。`,'ok')}catch(e){setStatus(`生成失敗：${e.message}`,'err')}};
    $('downloadDailyBtn').onclick=()=>generated?download(`${generated.id}_all_sets.json`,generated):setStatus('先に問題を生成してください','err');
    $('downloadSetsBtn').onclick=()=>{if(!generated)return setStatus('先に問題を生成してください','err');generated.sets.forEach(set=>download(`${set.id}.json`,{...generated,sets:[set]}))};
    loadBundled().then(validate).catch(e=>setStatus(`自動読込できません：${e.message}`,'err'));
  });
})();
