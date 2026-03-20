/**
 * problems.js
 * 問題データバンク + ランダム選択ユーティリティ
 *
 * 問題フォーマット:
 * {
 *   id: string,
 *   level: 1|2|3,
 *   grid: { cols: number, rows: number },
 *   lines: [ {x1,y1,x2,y2}, ... ],   // グリッド座標 (0-based)
 *   hintLines: [ {x1,y1,x2,y2}, ... ] // Level1のみ：事前描画される線
 * }
 *
 * グリッド座標は「点のインデックス」
 *   Level1/2: cols=4, rows=4  →  0..3 × 0..3
 *   Level3  : cols=5, rows=5  →  0..4 × 0..4
 *
 * ★ 禁止: 水平線だけ・垂直線だけの羅列、単純な四角形のみ
 * ★ 必須: 斜め線・交差・方向変化・複数方向の組み合わせ
 * ★ OK  : 交差あり、開いた図形（T字・十字・L字・Z字・複合形）
 */

const PROBLEM_BANK = {

  /* ===================================================================
     LEVEL 1  4×4 グリッド / 4本 / ヒント線2本
     条件: 必ず斜め線を1本以上含む。単純四角形・直線羅列禁止。
     ================================================================= */
  level1: [
    {
      // Z字形（斜め1本＋水平2本）
      id: 'L1-01', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:0, x2:3,y2:0},
        {x1:3,y1:0, x2:0,y2:3},
        {x1:0,y1:3, x2:3,y2:3},
        {x1:1,y1:1, x2:2,y2:2}
      ],
      hintLines: [
        {x1:0,y1:0, x2:3,y2:0},
        {x1:0,y1:3, x2:3,y2:3}
      ]
    },
    {
      // 矢印形（斜め2本＋縦1本＋横1本）
      id: 'L1-02', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:0, x2:2,y2:2},
        {x1:0,y1:3, x2:2,y2:2},
        {x1:2,y1:2, x2:3,y2:2},
        {x1:3,y1:0, x2:3,y2:3}
      ],
      hintLines: [
        {x1:0,y1:0, x2:2,y2:2},
        {x1:2,y1:2, x2:3,y2:2}
      ]
    },
    {
      // 旗形（L字＋斜め）
      id: 'L1-03', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:0, x2:0,y2:3},
        {x1:0,y1:0, x2:3,y2:1},
        {x1:3,y1:1, x2:0,y2:2},
        {x1:0,y1:3, x2:3,y2:3}
      ],
      hintLines: [
        {x1:0,y1:0, x2:0,y2:3},
        {x1:0,y1:3, x2:3,y2:3}
      ]
    },
    {
      // 稲妻形（ジグザグ斜め）
      id: 'L1-04', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:0, x2:2,y2:2},
        {x1:2,y1:2, x2:1,y2:1},
        {x1:1,y1:1, x2:3,y2:3},
        {x1:3,y1:3, x2:0,y2:3}
      ],
      hintLines: [
        {x1:0,y1:0, x2:2,y2:2},
        {x1:3,y1:3, x2:0,y2:3}
      ]
    },
    {
      // くさび形（斜め2本＋縦1本＋横1本）
      id: 'L1-05', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:3, x2:2,y2:0},
        {x1:2,y1:0, x2:3,y2:2},
        {x1:3,y1:2, x2:3,y2:3},
        {x1:3,y1:3, x2:0,y2:3}
      ],
      hintLines: [
        {x1:0,y1:3, x2:2,y2:0},
        {x1:3,y1:3, x2:0,y2:3}
      ]
    },
    {
      // 折れ線＋交差
      id: 'L1-06', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:0, x2:3,y2:3},
        {x1:3,y1:0, x2:0,y2:3},
        {x1:0,y1:1, x2:3,y2:1},
        {x1:1,y1:0, x2:1,y2:3}
      ],
      hintLines: [
        {x1:0,y1:0, x2:3,y2:3},
        {x1:0,y1:1, x2:3,y2:1}
      ]
    },
    {
      // 段形＋斜め（R字風）
      id: 'L1-07', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:0, x2:0,y2:3},
        {x1:0,y1:0, x2:2,y2:0},
        {x1:2,y1:0, x2:0,y2:2},
        {x1:0,y1:2, x2:3,y2:3}
      ],
      hintLines: [
        {x1:0,y1:0, x2:0,y2:3},
        {x1:0,y1:0, x2:2,y2:0}
      ]
    },
    {
      // クロス＋斜め飛び出し
      id: 'L1-08', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:1, x2:3,y2:1},
        {x1:1,y1:0, x2:1,y2:3},
        {x1:1,y1:1, x2:3,y2:3},
        {x1:2,y1:0, x2:3,y2:2}
      ],
      hintLines: [
        {x1:0,y1:1, x2:3,y2:1},
        {x1:1,y1:0, x2:1,y2:3}
      ]
    },
    {
      // ブーメラン形（斜め3本＋縦1本）
      id: 'L1-09', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:2, x2:2,y2:0},
        {x1:2,y1:0, x2:3,y2:2},
        {x1:3,y1:2, x2:1,y2:3},
        {x1:0,y1:2, x2:0,y2:3}
      ],
      hintLines: [
        {x1:0,y1:2, x2:2,y2:0},
        {x1:3,y1:2, x2:1,y2:3}
      ]
    },
    {
      // N字形（縦2本＋斜め1本＋横1本）
      id: 'L1-10', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:0, x2:0,y2:3},
        {x1:0,y1:0, x2:3,y2:3},
        {x1:3,y1:0, x2:3,y2:3},
        {x1:0,y1:3, x2:3,y2:3}
      ],
      hintLines: [
        {x1:0,y1:0, x2:0,y2:3},
        {x1:3,y1:0, x2:3,y2:3}
      ]
    }
  ],

  /* ===================================================================
     LEVEL 2  4×4 グリッド / 4本 / ヒントなし
     条件: 斜め線2本以上、または交差を含む。単純四角形・直線羅列禁止。
     ================================================================= */
  level2: [
    {
      // X字＋水平線（交差2か所）
      id: 'L2-01', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:0, x2:3,y2:3},
        {x1:3,y1:0, x2:0,y2:3},
        {x1:0,y1:1, x2:3,y2:1},
        {x1:0,y1:2, x2:3,y2:2}
      ],
      hintLines: []
    },
    {
      // 矢じり形（斜め3本＋横1本）
      id: 'L2-02', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:1, x2:3,y2:0},
        {x1:0,y1:1, x2:3,y2:3},
        {x1:3,y1:0, x2:1,y2:2},
        {x1:3,y1:3, x2:1,y2:2}
      ],
      hintLines: []
    },
    {
      // 凹字形（折れ線＋斜め）
      id: 'L2-03', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:0, x2:3,y2:0},
        {x1:0,y1:0, x2:0,y2:3},
        {x1:0,y1:3, x2:2,y2:1},
        {x1:2,y1:1, x2:3,y2:3}
      ],
      hintLines: []
    },
    {
      // 雷形（ジグザグ＋水平）
      id: 'L2-04', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:1,y1:0, x2:3,y2:0},
        {x1:1,y1:0, x2:0,y2:2},
        {x1:0,y1:2, x2:3,y2:2},
        {x1:3,y1:2, x2:2,y2:3}
      ],
      hintLines: []
    },
    {
      // 砂時計形（交差あり）
      id: 'L2-05', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:0, x2:3,y2:0},
        {x1:0,y1:0, x2:3,y2:3},
        {x1:3,y1:0, x2:0,y2:3},
        {x1:0,y1:3, x2:3,y2:3}
      ],
      hintLines: []
    },
    {
      // 風車羽根1枚形（斜め＋縦＋横の交差）
      id: 'L2-06', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:2, x2:3,y2:0},
        {x1:3,y1:0, x2:3,y2:3},
        {x1:3,y1:3, x2:0,y2:1},
        {x1:0,y1:1, x2:0,y2:2}
      ],
      hintLines: []
    },
    {
      // ハの字＋横棒交差
      id: 'L2-07', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:0, x2:2,y2:3},
        {x1:3,y1:0, x2:1,y2:3},
        {x1:0,y1:2, x2:3,y2:2},
        {x1:0,y1:1, x2:3,y2:1}
      ],
      hintLines: []
    },
    {
      // K字形（縦1本＋斜め2本＋横1本）
      id: 'L2-08', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:0, x2:0,y2:3},
        {x1:0,y1:1, x2:3,y2:0},
        {x1:0,y1:1, x2:3,y2:3},
        {x1:0,y1:3, x2:3,y2:3}
      ],
      hintLines: []
    },
    {
      // W字形（ジグザグ斜め4本）
      id: 'L2-09', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:0, x2:1,y2:3},
        {x1:1,y1:3, x2:2,y2:1},
        {x1:2,y1:1, x2:3,y2:3},
        {x1:0,y1:0, x2:3,y2:0}
      ],
      hintLines: []
    },
    {
      // 羽形（交差＋斜め飛び出し2本）
      id: 'L2-10', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        {x1:0,y1:3, x2:3,y2:0},
        {x1:0,y1:0, x2:3,y2:3},
        {x1:1,y1:2, x2:0,y2:3},
        {x1:2,y1:1, x2:3,y2:0}
      ],
      hintLines: []
    }
  ],

  /* ===================================================================
     LEVEL 3  5×5 グリッド / 5〜7本 / ヒントなし
     条件: 斜め線3本以上、または交差3か所以上含む複雑な構成。
     ================================================================= */
  level3: [
    {
      // 大X＋中心縦横（5交差）
      id: 'L3-01', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        {x1:0,y1:0, x2:4,y2:4},
        {x1:4,y1:0, x2:0,y2:4},
        {x1:2,y1:0, x2:2,y2:4},
        {x1:0,y1:2, x2:4,y2:2},
        {x1:0,y1:0, x2:4,y2:0}
      ],
      hintLines: []
    },
    {
      // 星形骨格（斜め4本＋中心放射）
      id: 'L3-02', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        {x1:2,y1:0, x2:2,y2:4},
        {x1:0,y1:2, x2:4,y2:2},
        {x1:0,y1:0, x2:4,y2:4},
        {x1:4,y1:0, x2:0,y2:4},
        {x1:1,y1:1, x2:3,y2:3}
      ],
      hintLines: []
    },
    {
      // 複合折れ線（右下がり段階形＋交差）
      id: 'L3-03', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        {x1:0,y1:0, x2:4,y2:0},
        {x1:4,y1:0, x2:0,y2:4},
        {x1:0,y1:4, x2:4,y2:4},
        {x1:0,y1:0, x2:0,y2:4},
        {x1:2,y1:0, x2:2,y2:4},
        {x1:0,y1:2, x2:4,y2:2}
      ],
      hintLines: []
    },
    {
      // 矢印＋X交差（放射状）
      id: 'L3-04', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        {x1:0,y1:2, x2:4,y2:2},
        {x1:2,y1:0, x2:2,y2:4},
        {x1:0,y1:0, x2:4,y2:4},
        {x1:4,y1:0, x2:0,y2:4},
        {x1:0,y1:0, x2:4,y2:0},
        {x1:0,y1:4, x2:4,y2:4}
      ],
      hintLines: []
    },
    {
      // 凸多角形＋内部対角線（複雑閉図形）
      id: 'L3-05', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        {x1:1,y1:0, x2:3,y2:0},
        {x1:3,y1:0, x2:4,y2:2},
        {x1:4,y1:2, x2:3,y2:4},
        {x1:3,y1:4, x2:1,y2:4},
        {x1:1,y1:4, x2:0,y2:2},
        {x1:0,y1:2, x2:1,y2:0},
        {x1:1,y1:0, x2:3,y2:4}
      ],
      hintLines: []
    },
    {
      // H形＋斜め交差（多方向複合）
      id: 'L3-06', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        {x1:0,y1:0, x2:0,y2:4},
        {x1:4,y1:0, x2:4,y2:4},
        {x1:0,y1:2, x2:4,y2:2},
        {x1:0,y1:0, x2:4,y2:4},
        {x1:4,y1:0, x2:0,y2:4}
      ],
      hintLines: []
    },
    {
      // 電光形（ジグザグ大＋水平補助線）
      id: 'L3-07', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        {x1:0,y1:0, x2:4,y2:0},
        {x1:4,y1:0, x2:0,y2:2},
        {x1:0,y1:2, x2:4,y2:2},
        {x1:4,y1:2, x2:0,y2:4},
        {x1:0,y1:4, x2:4,y2:4},
        {x1:2,y1:1, x2:2,y2:3}
      ],
      hintLines: []
    },
    {
      // 風車形（4本斜め放射＋中心横）
      id: 'L3-08', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        {x1:2,y1:0, x2:4,y2:2},
        {x1:4,y1:2, x2:2,y2:4},
        {x1:2,y1:4, x2:0,y2:2},
        {x1:0,y1:2, x2:2,y2:0},
        {x1:0,y1:1, x2:4,y2:3},
        {x1:4,y1:1, x2:0,y2:3}
      ],
      hintLines: []
    },
    {
      // K字＋対角線（複合交差）
      id: 'L3-09', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        {x1:0,y1:0, x2:0,y2:4},
        {x1:0,y1:2, x2:4,y2:0},
        {x1:0,y1:2, x2:4,y2:4},
        {x1:0,y1:0, x2:4,y2:4},
        {x1:0,y1:4, x2:4,y2:4}
      ],
      hintLines: []
    },
    {
      // ダイヤ＋十字（内外複合）
      id: 'L3-10', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        {x1:2,y1:0, x2:4,y2:2},
        {x1:4,y1:2, x2:2,y2:4},
        {x1:2,y1:4, x2:0,y2:2},
        {x1:0,y1:2, x2:2,y2:0},
        {x1:0,y1:0, x2:4,y2:4},
        {x1:4,y1:0, x2:0,y2:4}
      ],
      hintLines: []
    }
  ]
};

/**
 * 指定レベルから5問をランダムにシャッフルして返す
 */
function getProblems(level) {
  const pool = PROBLEM_BANK[`level${level}`];
  if (!pool || pool.length === 0) return [];

  const arr = [...pool];
  // Fisher-Yates シャッフル
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const shuffled = [];
  while (shuffled.length < 5) shuffled.push(...arr);
  return shuffled.slice(0, 5);
}

/**
 * AIから受け取った問題データを正規化する
 */
function normalizeProblem(raw, level) {
  const gridSize = level === 3 ? 5 : 4;
  const maxCoord = gridSize - 1;
  const grid = raw.grid || { cols: gridSize, rows: gridSize };

  const lines = (raw.lines || [])
    .map(l => ({
      x1: Math.min(Math.max(Math.round(Number(l.x1)), 0), maxCoord),
      y1: Math.min(Math.max(Math.round(Number(l.y1)), 0), maxCoord),
      x2: Math.min(Math.max(Math.round(Number(l.x2)), 0), maxCoord),
      y2: Math.min(Math.max(Math.round(Number(l.y2)), 0), maxCoord)
    }))
    // 同一点の線を除外
    .filter(l => !(l.x1 === l.x2 && l.y1 === l.y2));

  let hintLines = [];
  if (level === 1 && lines.length >= 2) {
    // 斜め線をヒントに含まない（回答しやすい水平・垂直線をヒントにする）
    const straightLines = lines.filter(l => l.x1 === l.x2 || l.y1 === l.y2);
    const diagLines     = lines.filter(l => l.x1 !== l.x2 && l.y1 !== l.y2);
    if (straightLines.length >= 2) {
      hintLines = straightLines.slice(0, 2);
    } else {
      hintLines = lines.slice(0, 2);
    }
  }

  return {
    id: `AI-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    level,
    grid,
    lines,
    hintLines
  };
}
