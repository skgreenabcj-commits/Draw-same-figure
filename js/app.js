/**
 * app.js  v2.4
 *
 * 【v2.4 変更点】
 *   - 管理者AIモデル設定UIをすべて admin.html へ移管
 *   - openAdminModelPanel / saveAdminModelSettings を削除
 *   - geminiStatusUpdate イベント受信 → エラーバナー表示のみ維持
 *   - バナークリック → admin.html へ遷移
 *   - 初回起動時に APIキー設定済み・管理チェーン未設定なら案内バナー表示
 *
 * 【v2.3 以前の変更点（維持）】
 *   Promise.race によるタイムアウトガード (30s)
 *   Bug #3/#4/#5 修正
 */

const AppState = {
  level:        1,
  problems:     [],
  currentIndex: 0,
  score:        0,
  useAI:        false,
  apiKey:       ''
};

const PRAISE_LIST = [
  'すごい！ぴったり！','かんぺき！！ 🎉','やったね！ばっちり！','さすが！！ てんさい！',
  'せいかい！よくできました！','かっこいい！','おみごと！！ 🌟','すばらしい！！'
];
function randomPraise(){ return PRAISE_LIST[Math.floor(Math.random()*PRAISE_LIST.length)]; }

function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function judgeAnswer(problem,userLines){
  const correct=problem.lines;
  const hint=problem.hintLines||[];
  const allUserLines=[...hint,...userLines];
  if(allUserLines.length!==correct.length)return false;
  const normalize=l=>[`${l.x1},${l.y1}-${l.x2},${l.y2}`,`${l.x2},${l.y2}-${l.x1},${l.y1}`].sort()[0];
  const correctSet=new Set(correct.map(normalize));
  for(const line of allUserLines){if(!correctSet.has(normalize(line)))return false;}
  const userSet=new Set(allUserLines.map(normalize));
  return userSet.size===correctSet.size;
}

function updateProgress(){
  const total=AppState.problems.length;const cur=AppState.currentIndex+1;
  document.getElementById('progress-text').textContent=`${cur} / ${total}もん`;
  document.getElementById('progress-bar').style.width=`${(cur/total)*100}%`;
  document.getElementById('score-text').textContent=`⭐ ${AppState.score}`;
}

function updateHintMsg(problem){
  const hintEl=document.getElementById('hint-msg');
  if(problem.level!==0&&problem.level!==1){hintEl.classList.add('hidden');return;}
  const remain=problem.lines.length-(problem.hintLines||[]).length;
  document.getElementById('hint-remain').textContent=remain;
  hintEl.classList.remove('hidden');
}

function _refreshOverlayLimit(problem,lineCount){
  const ov=document.getElementById('canvas-overlay');if(!ov)return;
  if(problem.level!==0&&problem.level!==1){ov.style.pointerEvents='auto';ov.style.cursor='crosshair';return;}
  const maxLines=problem.lines.length-(problem.hintLines||[]).length;
  if(lineCount>=maxLines){ov.style.pointerEvents='none';ov.style.cursor='not-allowed';}
  else{ov.style.pointerEvents='auto';ov.style.cursor='crosshair';}
}

function loadQuestion(index){
  const problem=AppState.problems[index];AppState.currentIndex=index;
  updateProgress();initCanvases(problem);updateHintMsg(problem);buildGridHeaders(problem);
  requestAnimationFrame(()=>{requestAnimationFrame(()=>{
    drawModel(problem);drawAnswer(problem);
    setupInteraction(problem,(lineCount)=>{_refreshOverlayLimit(problem,lineCount);});
    _refreshOverlayLimit(problem,0);
  });});
}

function checkAnswer(){
  const problem=AppState.problems[AppState.currentIndex];
  const userLines=getAnswerLines();const isCorrect=judgeAnswer(problem,userLines);
  document.getElementById('feedback-overlay').classList.remove('hidden');
  if(isCorrect){
    AppState.score++;document.getElementById('score-text').textContent=`⭐ ${AppState.score}`;
    document.getElementById('feedback-wrong').classList.add('hidden');
    document.getElementById('feedback-correct').classList.remove('hidden');
    document.getElementById('praise-text').textContent=randomPraise();
    const img=document.querySelector('.gotit-img');img.style.animation='none';img.offsetHeight;img.style.animation='';
  }else{
    document.getElementById('feedback-correct').classList.add('hidden');
    document.getElementById('feedback-wrong').classList.remove('hidden');
    drawWrongFeedback(problem,userLines);
  }
}

function goNext(){
  document.getElementById('feedback-overlay').classList.add('hidden');
  const next=AppState.currentIndex+1;
  if(next>=AppState.problems.length)showResult();else loadQuestion(next);
}

function showResult(){
  showScreen('screen-result');
  const score=AppState.score;const total=AppState.problems.length;
  document.getElementById('final-score').textContent=score;
  let msg='';
  if(score===total)msg='ぜんぶせいかい！！ あなたはてんさい！🎉';
  else if(score>=total*0.8)msg='とてもよくできました！';
  else if(score>=total*0.6)msg='よくがんばりました！';
  else msg='がんばった！またあそぼう！！';
  document.getElementById('result-msg').textContent=msg;
}

async function startGame(){
  const level=AppState.level;const apiKey=AppState.apiKey;
  if(apiKey){
    showLoading(true);
    try{
      const timeoutPromise=new Promise((_,reject)=>setTimeout(()=>reject(new Error('タイムアウト')),30000));
      AppState.problems=await Promise.race([generateProblems(level,5,apiKey),timeoutPromise]);
    }catch(e){console.warn('AI生成失敗:',e.message);AppState.problems=getProblems(level);}
    finally{showLoading(false);}
  }else{AppState.problems=getProblems(level);}
  AppState.score=0;AppState.currentIndex=0;
  showScreen('screen-game');
  requestAnimationFrame(()=>{requestAnimationFrame(()=>{loadQuestion(0);});});
}

function showLoading(show){document.getElementById('loading-overlay').classList.toggle('hidden',!show);}

/* ── エラーバナー（admin.html への導線） ── */
function showErrorBanner(message,type='error'){
  const banner=document.getElementById('model-error-banner');if(!banner)return;
  banner.textContent=type==='error'
    ?`⚠️ AI: ${message}　（タップして管理者設定）`
    :`💡 ${message}　（タップして管理者設定）`;
  banner.className=`model-error-banner model-error-banner--${type}`;
  banner.classList.remove('hidden');
}
function hideErrorBanner(){const banner=document.getElementById('model-error-banner');if(banner)banner.classList.add('hidden');}

/* ── イベントバインド ── */
document.addEventListener('DOMContentLoaded',()=>{

  /* スタート画面 */
  document.querySelectorAll('.level-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.level-btn').forEach(b=>b.classList.remove('selected'));
      btn.classList.add('selected');AppState.level=parseInt(btn.dataset.level,10);
      document.getElementById('btn-start').disabled=false;
    });
  });
  document.getElementById('btn-start').addEventListener('click',startGame);

  document.getElementById('btn-toggle-api').addEventListener('click',()=>{
    document.getElementById('api-key-panel').classList.toggle('hidden');
  });
  document.getElementById('btn-save-api').addEventListener('click',()=>{
    const key=document.getElementById('input-api-key').value.trim();
    if(key){
      saveApiKey(key);AppState.apiKey=key;clearModelCache();
      alert('APIキーを保存しました。');
      if(!loadAdminChain())showErrorBanner('AIモデルが未設定です。管理者設定から推奨モデルを選んでください。','info');
    }else{saveApiKey('');AppState.apiKey='';clearModelCache();hideErrorBanner();alert('APIキーをクリアしました。');}
  });
  const savedKey=loadApiKey();
  if(savedKey){AppState.apiKey=savedKey;document.getElementById('input-api-key').value=savedKey;}

  /* admin.html リンク */
  document.getElementById('btn-admin-model')
    ?.addEventListener('click',()=>{window.open('admin.html','_blank');});
  document.getElementById('model-error-banner')
    ?.addEventListener('click',()=>{window.open('admin.html','_blank');});

  /* ゲーム画面 */
  document.getElementById('btn-home').addEventListener('click',()=>{
    if(confirm('ホームに戻りますか？'))showScreen('screen-start');
  });
  document.getElementById('btn-clear').addEventListener('click',()=>{
    clearAnswerLines();const problem=AppState.problems[AppState.currentIndex];
    if(problem)_refreshOverlayLimit(problem,0);
  });
  document.getElementById('btn-undo').addEventListener('click',()=>{
    undoLastLine();const problem=AppState.problems[AppState.currentIndex];
    const lineCount=getAnswerLines().length;if(problem)_refreshOverlayLimit(problem,lineCount);
  });
  document.getElementById('btn-check').addEventListener('click',checkAnswer);
  document.getElementById('btn-next-wrong').addEventListener('click',goNext);
  document.getElementById('btn-next-correct').addEventListener('click',goNext);

  /* 結果画面 */
  document.getElementById('btn-retry').addEventListener('click',startGame);
  document.getElementById('btn-result-home').addEventListener('click',()=>showScreen('screen-start'));

  /* geminiStatusUpdate 監視 */
  window.addEventListener('geminiStatusUpdate',(e)=>{
    const status=e.detail;if(!status)return;
    if(status.lastError)showErrorBanner(status.lastError,'error');
    // 廃止モデル検出時はバナーだけ表示（admin.htmlへの誘導で対応）
  });

  /* デフォルトレベル選択 */
  const defaultLvBtn=document.querySelector('.level-btn[data-level="1"]');
  if(defaultLvBtn){defaultLvBtn.classList.add('selected');AppState.level=1;document.getElementById('btn-start').disabled=false;}

  /* 初回案内バナー */
  if(AppState.apiKey&&!loadAdminChain()){
    setTimeout(()=>showErrorBanner('AIモデルが未設定です。管理者設定から推奨モデルを選んでください。','info'),600);
  }
});
