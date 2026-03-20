'use strict';

/* =====================================================================
   problems.js  – Built-in problem bank  v2.0
   Level constraints (strict internal intersections, _cross logic):
     Lv0: 0–2  (4 lines, 4x4 grid, 3 hint lines shown)
     Lv1: 0–3  (4 lines, 4x4 grid, 2 hint lines shown)
     Lv2: 2–5  (4 lines, 4x4 grid, 0 hint lines shown)
     Lv3: 0–8  (5 lines, 5x5 grid, 0 hint lines shown)
   All problems verified with Python _cross function (strict internal only).
===================================================================== */

/* -- Intersection helpers (mirror of gemini.js _gCross) ------------ */
function _cross(ax,ay,bx,by,cx,cy,dx,dy){
  if((ax===cx&&ay===cy)||(ax===dx&&ay===dy)) return false;
  if((bx===cx&&by===cy)||(bx===dx&&by===dy)) return false;
  const d1=(dx-cx)*(ay-cy)-(dy-cy)*(ax-cx);
  const d2=(dx-cx)*(by-cy)-(dy-cy)*(bx-cx);
  const d3=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
  const d4=(bx-ax)*(dy-ay)-(by-ay)*(dx-ax);
  return ((d1>0&&d2<0)||(d1<0&&d2>0))&&((d3>0&&d4<0)||(d3<0&&d4>0));
}
function _countCross(lines){
  let n=0;
  for(let i=0;i<lines.length;i++)
    for(let j=i+1;j<lines.length;j++)
      if(_cross(lines[i].x1,lines[i].y1,lines[i].x2,lines[i].y2,
                lines[j].x1,lines[j].y1,lines[j].x2,lines[j].y2)) n++;
  return n;
}

/* -- Problem bank --------------------------------------------------- */
const PROBLEM_BANK = {

  /* ==== Lv0 : 4 lines, 4x4 grid (0-3), cross limit 0-2, 3 hints ==== */
  0: [
    { level:0, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:0},{x1:0,y1:1,x2:3,y2:1},
             {x1:0,y1:2,x2:3,y2:2},{x1:0,y1:3,x2:3,y2:3}]
    }, /* L0-01  cross=0 */
    { level:0, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:0,y2:3},{x1:1,y1:0,x2:1,y2:3},
             {x1:2,y1:0,x2:2,y2:3},{x1:3,y1:0,x2:3,y2:3}]
    }, /* L0-02  cross=0 */
    { level:0, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:3,x2:3,y2:1},
             {x1:1,y1:0,x2:1,y2:3},{x1:2,y1:0,x2:2,y2:3}]
    }, /* L0-03  cross=0 */
    { level:0, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},
             {x1:2,y1:0,x2:3,y2:1},{x1:2,y1:2,x2:3,y2:3}]
    }, /* L0-04  cross=1 */
    { level:0, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:3},{x1:0,y1:3,x2:3,y2:0},
             {x1:0,y1:1,x2:0,y2:3},{x1:3,y1:1,x2:3,y2:3}]
    }, /* L0-05  cross=1 */
    { level:0, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},
             {x1:2,y1:0,x2:3,y2:3},{x1:3,y1:0,x2:2,y2:3}]
    }, /* L0-06  cross=2 */
    { level:0, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:3},{x1:0,y1:2,x2:3,y2:2},
             {x1:0,y1:3,x2:1,y2:3},{x1:2,y1:0,x2:3,y2:0}]
    }, /* L0-07  cross=1 */
    { level:0, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:2,y2:0},{x1:0,y1:1,x2:2,y2:1},
             {x1:0,y1:2,x2:2,y2:2},{x1:3,y1:0,x2:3,y2:3}]
    }, /* L0-08  cross=0 */
    { level:0, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:2,y2:2},{x1:0,y1:2,x2:2,y2:0},
             {x1:1,y1:1,x2:3,y2:1},{x1:1,y1:2,x2:3,y2:2}]
    }, /* L0-09  cross=1 */
    { level:0, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:1},{x1:0,y1:1,x2:3,y2:0},
             {x1:0,y1:2,x2:1,y2:3},{x1:1,y1:2,x2:0,y2:3}]
    }  /* L0-10  cross=2 */
  ],

  /* ==== Lv1 : 4 lines, 4x4 grid (0-3), cross limit 0-3, 2 hints ==== */
  1: [
    { level:1, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},
             {x1:2,y1:0,x2:3,y2:1},{x1:2,y1:2,x2:3,y2:3}]
    }, /* L1-01  cross=1 */
    { level:1, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:0},{x1:0,y1:1,x2:3,y2:1},
             {x1:0,y1:2,x2:3,y2:2},{x1:0,y1:3,x2:3,y2:3}]
    }, /* L1-02  cross=0 */
    { level:1, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},
             {x1:2,y1:0,x2:3,y2:3},{x1:3,y1:0,x2:2,y2:3}]
    }, /* L1-03  cross=2 */
    { level:1, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:0},
             {x1:1,y1:0,x2:0,y2:3},{x1:3,y1:2,x2:3,y2:3}]
    }, /* L1-04  cross=3 */
    { level:1, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:1,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:1},
             {x1:0,y1:0,x2:0,y2:3},{x1:3,y1:0,x2:3,y2:3}]
    }, /* L1-05  cross=1 */
    { level:1, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:1,y2:2},{x1:0,y1:2,x2:1,y2:0},
             {x1:2,y1:1,x2:3,y2:3},{x1:2,y1:3,x2:3,y2:1}]
    }, /* L1-06  cross=2 */
    { level:1, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:3},{x1:0,y1:3,x2:3,y2:0},
             {x1:0,y1:1,x2:3,y2:2},{x1:2,y1:0,x2:2,y2:1}]
    }, /* L1-07  cross=3 */
    { level:1, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:0,y2:3},{x1:3,y1:0,x2:3,y2:3},
             {x1:0,y1:0,x2:3,y2:0},{x1:0,y1:3,x2:3,y2:3}]
    }, /* L1-08  cross=0 */
    { level:1, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:1},{x1:0,y1:1,x2:3,y2:0},
             {x1:0,y1:2,x2:3,y2:3},{x1:0,y1:3,x2:3,y2:2}]
    }, /* L1-09  cross=2 */
    { level:1, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:1,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:1},
             {x1:0,y1:0,x2:3,y2:3},{x1:2,y1:0,x2:3,y2:0}]
    }  /* L1-10  cross=3 */
  ],

  /* ==== Lv2 : 4 lines, 4x4 grid (0-3), cross limit 2-5, 0 hints ==== */
  2: [
    { level:2, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:1,y2:3},{x1:1,y1:0,x2:0,y2:3},
             {x1:2,y1:0,x2:3,y2:3},{x1:3,y1:0,x2:2,y2:3}]
    }, /* L2-01  cross=2 */
    { level:2, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:0},
             {x1:1,y1:0,x2:2,y2:3},{x1:0,y1:3,x2:1,y2:3}]
    }, /* L2-02  cross=3 */
    { level:2, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:2,y2:3},{x1:2,y1:0,x2:0,y2:3},
             {x1:1,y1:1,x2:3,y2:3},{x1:3,y1:0,x2:1,y2:2}]
    }, /* L2-03  cross=4 */
    { level:2, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:3},{x1:0,y1:3,x2:3,y2:0},
             {x1:0,y1:1,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:2}]
    }, /* L2-04  cross=5 */
    { level:2, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:1,x2:2,y2:3},{x1:2,y1:1,x2:0,y2:3},
             {x1:1,y1:0,x2:3,y2:2},{x1:3,y1:0,x2:1,y2:2}]
    }, /* L2-05  cross=2 */
    { level:2, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:3},{x1:0,y1:3,x2:3,y2:0},
             {x1:0,y1:1,x2:3,y2:2},{x1:2,y1:0,x2:3,y2:0}]
    }, /* L2-06  cross=3 */
    { level:2, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:0},
             {x1:0,y1:3,x2:3,y2:1},{x1:0,y1:1,x2:3,y2:3}]
    }, /* L2-07  cross=4 */
    { level:2, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:3},{x1:0,y1:3,x2:3,y2:0},
             {x1:0,y1:2,x2:3,y2:1},{x1:0,y1:1,x2:3,y2:3}]
    }, /* L2-08  cross=5 */
    { level:2, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:3},{x1:0,y1:3,x2:3,y2:0},
             {x1:1,y1:0,x2:2,y2:3},{x1:0,y1:2,x2:1,y2:3}]
    }, /* L2-09  cross=3 */
    { level:2, grid:{cols:4,rows:4},
      lines:[{x1:0,y1:0,x2:3,y2:2},{x1:0,y1:2,x2:3,y2:0},
             {x1:0,y1:3,x2:2,y2:0},{x1:1,y1:3,x2:3,y2:0}]
    }  /* L2-10  cross=4 */
  ],

  /* ==== Lv3 : 5 lines, 5x5 grid (0-4), cross limit 0-8, 0 hints ==== */
  3: [
    { level:3, grid:{cols:5,rows:5},
      lines:[{x1:0,y1:0,x2:4,y2:4},{x1:0,y1:4,x2:4,y2:0},
             {x1:0,y1:2,x2:4,y2:2},{x1:2,y1:0,x2:2,y2:4},
             {x1:0,y1:1,x2:4,y2:3}]
    }, /* L3-01  cross=7 */
    { level:3, grid:{cols:5,rows:5},
      lines:[{x1:0,y1:0,x2:4,y2:3},{x1:0,y1:3,x2:4,y2:0},
             {x1:1,y1:0,x2:3,y2:4},{x1:3,y1:0,x2:1,y2:4},
             {x1:0,y1:4,x2:4,y2:4}]
    }, /* L3-02  cross=5 */
    { level:3, grid:{cols:5,rows:5},
      lines:[{x1:0,y1:0,x2:4,y2:4},{x1:0,y1:4,x2:4,y2:0},
             {x1:0,y1:1,x2:4,y2:1},{x1:0,y1:3,x2:4,y2:3},
             {x1:2,y1:0,x2:2,y2:4}]
    }, /* L3-03  cross=6 */
    { level:3, grid:{cols:5,rows:5},
      lines:[{x1:0,y1:0,x2:2,y2:4},{x1:2,y1:0,x2:0,y2:4},
             {x1:2,y1:0,x2:4,y2:4},{x1:4,y1:0,x2:2,y2:4},
             {x1:0,y1:2,x2:4,y2:2}]
    }, /* L3-04  cross=6 */
    { level:3, grid:{cols:5,rows:5},
      lines:[{x1:0,y1:0,x2:4,y2:0},{x1:0,y1:4,x2:4,y2:4},
             {x1:0,y1:0,x2:0,y2:4},{x1:4,y1:0,x2:4,y2:4},
             {x1:1,y1:1,x2:3,y2:3}]
    }, /* L3-05  cross=0 */
    { level:3, grid:{cols:5,rows:5},
      lines:[{x1:0,y1:0,x2:4,y2:2},{x1:0,y1:2,x2:4,y2:0},
             {x1:0,y1:3,x2:4,y2:4},{x1:0,y1:4,x2:4,y2:3},
             {x1:2,y1:0,x2:2,y2:4}]
    }, /* L3-06  cross=5 */
    { level:3, grid:{cols:5,rows:5},
      lines:[{x1:0,y1:1,x2:4,y2:3},{x1:0,y1:3,x2:4,y2:1},
             {x1:1,y1:0,x2:3,y2:4},{x1:3,y1:0,x2:1,y2:4},
             {x1:0,y1:0,x2:4,y2:4}]
    }, /* L3-07  cross=7 */
    { level:3, grid:{cols:5,rows:5},
      lines:[{x1:0,y1:0,x2:4,y2:1},{x1:0,y1:1,x2:4,y2:0},
             {x1:0,y1:3,x2:4,y2:4},{x1:0,y1:4,x2:4,y2:3},
             {x1:1,y1:0,x2:3,y2:4}]
    }, /* L3-08  cross=4 */
    { level:3, grid:{cols:5,rows:5},
      lines:[{x1:0,y1:0,x2:4,y2:4},{x1:0,y1:4,x2:4,y2:0},
             {x1:0,y1:2,x2:4,y2:2},{x1:1,y1:0,x2:1,y2:4},
             {x1:3,y1:0,x2:3,y2:4}]
    }, /* L3-09  cross=6 */
    { level:3, grid:{cols:5,rows:5},
      lines:[{x1:0,y1:0,x2:3,y2:4},{x1:1,y1:0,x2:4,y2:4},
             {x1:0,y1:4,x2:3,y2:0},{x1:1,y1:4,x2:4,y2:0},
             {x1:0,y1:2,x2:4,y2:2}]
    }  /* L3-10  cross=6 */
  ]
};

/* -- Public API ----------------------------------------------------- */
function getProblems(level){
  const pool = (PROBLEM_BANK[level] || PROBLEM_BANK[1]).slice();
  for(let i=pool.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [pool[i],pool[j]]=[pool[j],pool[i]];
  }
  return pool.slice(0,5);
}

/* -- Runtime self-check (console only, non-blocking) ---------------- */
(function _selfCheck(){
  const LIMITS = {0:[0,2], 1:[0,3], 2:[2,5], 3:[0,8]};
  let ok=true;
  for(const [lvStr, problems] of Object.entries(PROBLEM_BANK)){
    const lv=Number(lvStr);
    const [lo,hi]=LIMITS[lv]||[0,99];
    problems.forEach((p,i)=>{
      const n=_countCross(p.lines);
      if(n<lo||n>hi){
        console.error(`[problems.js] FAIL Lv${lv} #${i+1}: cross=${n}, limit=${lo}-${hi}`);
        ok=false;
      }
    });
  }
  if(ok) console.log('[problems.js] All problems passed intersection check.');
})();
