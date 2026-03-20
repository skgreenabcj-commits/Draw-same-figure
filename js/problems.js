/**
 * problems.js
 * 問題データバンク + ランダム選択ユーティリティ
 *
 * 問題フォーマット:
 * {
 *   id: string,
 *   level: 0|1|2|3,
 *   grid: { cols: number, rows: number },
 *   lines: [ {x1,y1,x2,y2}, ... ],
 *   hintLines: [ {x1,y1,x2,y2}, ... ]
 * }
 *
 * Level0: cols=4, rows=4 / 4本 / ヒント3本（残り1本だけ引く）
 * Level1: cols=4, rows=4 / 4本 / ヒント2本
 * Level2: cols=4, rows=4 / 4本 / ヒントなし
 * Level3: cols=5, rows=5 / 5〜7本 / ヒントなし
 */

const PROBLEM_BANK = {

  /* ===================================================================
     LEVEL 0  4×4 グリッド / 4本 / ヒント線3本（残り1本のみ引く）
     条件: 必ず斜め線を1本以上含む。ヒント3本は直線系を優先し、
           残す1本（ユーザーが引く線）は斜め線にして難易度を下げる。
     ================================================================= */
  level0: [
    {
      // Z字形：斜め1本が回答
      id: 'L0-01', level: 0, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:3,y2:0 },
        { x1:3,y1:0, x2:0,y2:3 },
        { x1:0,y1:3, x2:3,y2:3 },
        { x1:1,y1:1, x2:2,y2:2 }
      ],
      hintLines: [
        { x1:0,y1:0, x2:3,y2:0 },
        { x1:0,y1:3, x2:3,y2:3 },
        { x1:3,y1:0, x2:0,y2:3 }
      ]
    },
    {
      // 矢印形：斜め（0,3→2,2）が回答
      id: 'L0-02', level: 0, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:2,y2:2 },
        { x1:0,y1:3, x2:2,y2:2 },
        { x1:2,y1:2, x2:3,y2:2 },
        { x1:3,y1:0, x2:3,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:0, x2:2,y2:2 },
        { x1:2,y1:2, x2:3,y2:2 },
        { x1:3,y1:0, x2:3,y2:3 }
      ]
    },
    {
      // 旗形：斜め（3,1→0,2）が回答
      id: 'L0-03', level: 0, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:0,y2:3 },
        { x1:0,y1:0, x2:3,y2:1 },
        { x1:3,y1:1, x2:0,y2:2 },
        { x1:0,y1:3, x2:3,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:0, x2:0,y2:3 },
        { x1:0,y1:0, x2:3,y2:1 },
        { x1:0,y1:3, x2:3,y2:3 }
      ]
    },
    {
      // 稲妻形：斜め（1,1→3,3）が回答
      id: 'L0-04', level: 0, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:2,y2:2 },
        { x1:2,y1:2, x2:1,y2:1 },
        { x1:1,y1:1, x2:3,y2:3 },
        { x1:3,y1:3, x2:0,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:0, x2:2,y2:2 },
        { x1:2,y1:2, x2:1,y2:1 },
        { x1:3,y1:3, x2:0,y2:3 }
      ]
    },
    {
      // くさび形：斜め（2,0→3,2）が回答
      id: 'L0-05', level: 0, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:3, x2:2,y2:0 },
        { x1:2,y1:0, x2:3,y2:2 },
        { x1:3,y1:2, x2:3,y2:3 },
        { x1:3,y1:3, x2:0,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:3, x2:2,y2:0 },
        { x1:3,y1:2, x2:3,y2:3 },
        { x1:3,y1:3, x2:0,y2:3 }
      ]
    },
    {
      // 折れ線＋交差：斜め（3,0→0,3）が回答
      id: 'L0-06', level: 0, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:3,y2:3 },
        { x1:3,y1:0, x2:0,y2:3 },
        { x1:0,y1:1, x2:3,y2:1 },
        { x1:1,y1:0, x2:1,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:0, x2:3,y2:3 },
        { x1:0,y1:1, x2:3,y2:1 },
        { x1:1,y1:0, x2:1,y2:3 }
      ]
    },
    {
      // 段形＋斜め：斜め（0,2→3,3）が回答
      id: 'L0-07', level: 0, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:0,y2:3 },
        { x1:0,y1:0, x2:2,y2:0 },
        { x1:2,y1:0, x2:0,y2:2 },
        { x1:0,y1:2, x2:3,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:0, x2:0,y2:3 },
        { x1:0,y1:0, x2:2,y2:0 },
        { x1:2,y1:0, x2:0,y2:2 }
      ]
    },
    {
      // クロス＋斜め：斜め（1,1→3,3）が回答
      id: 'L0-08', level: 0, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:1, x2:3,y2:1 },
        { x1:1,y1:0, x2:1,y2:3 },
        { x1:1,y1:1, x2:3,y2:3 },
        { x1:2,y1:0, x2:3,y2:2 }
      ],
      hintLines: [
        { x1:0,y1:1, x2:3,y2:1 },
        { x1:1,y1:0, x2:1,y2:3 },
        { x1:2,y1:0, x2:3,y2:2 }
      ]
    },
    {
      // ブーメラン形：斜め（2,0→3,2）が回答
      id: 'L0-09', level: 0, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:2, x2:2,y2:0 },
        { x1:2,y1:0, x2:3,y2:2 },
        { x1:3,y1:2, x2:1,y2:3 },
        { x1:0,y1:2, x2:0,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:2, x2:2,y2:0 },
        { x1:3,y1:2, x2:1,y2:3 },
        { x1:0,y1:2, x2:0,y2:3 }
      ]
    },
    {
      // N字形：斜め（0,0→3,3）が回答
      id: 'L0-10', level: 0, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:0,y2:3 },
        { x1:0,y1:0, x2:3,y2:3 },
        { x1:3,y1:0, x2:3,y2:3 },
        { x1:0,y1:3, x2:3,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:0, x2:0,y2:3 },
        { x1:3,y1:0, x2:3,y2:3 },
        { x1:0,y1:3, x2:3,y2:3 }
      ]
    }
  ],

  /* ===================================================================
     LEVEL 1  4×4 グリッド / 4本 / ヒント線2本
     ================================================================= */
  level1: [
    {
      id: 'L1-01', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:3,y2:0 },
        { x1:3,y1:0, x2:0,y2:3 },
        { x1:0,y1:3, x2:3,y2:3 },
        { x1:1,y1:1, x2:2,y2:2 }
      ],
      hintLines: [
        { x1:0,y1:0, x2:3,y2:0 },
        { x1:0,y1:3, x2:3,y2:3 }
      ]
    },
    {
      id: 'L1-02', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:2,y2:2 },
        { x1:0,y1:3, x2:2,y2:2 },
        { x1:2,y1:2, x2:3,y2:2 },
        { x1:3,y1:0, x2:3,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:0, x2:2,y2:2 },
        { x1:2,y1:2, x2:3,y2:2 }
      ]
    },
    {
      id: 'L1-03', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:0,y2:3 },
        { x1:0,y1:0, x2:3,y2:1 },
        { x1:3,y1:1, x2:0,y2:2 },
        { x1:0,y1:3, x2:3,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:0, x2:0,y2:3 },
        { x1:0,y1:3, x2:3,y2:3 }
      ]
    },
    {
      id: 'L1-04', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:2,y2:2 },
        { x1:2,y1:2, x2:1,y2:1 },
        { x1:1,y1:1, x2:3,y2:3 },
        { x1:3,y1:3, x2:0,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:0, x2:2,y2:2 },
        { x1:3,y1:3, x2:0,y2:3 }
      ]
    },
    {
      id: 'L1-05', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:3, x2:2,y2:0 },
        { x1:2,y1:0, x2:3,y2:2 },
        { x1:3,y1:2, x2:3,y2:3 },
        { x1:3,y1:3, x2:0,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:3, x2:2,y2:0 },
        { x1:3,y1:3, x2:0,y2:3 }
      ]
    },
    {
      id: 'L1-06', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:3,y2:3 },
        { x1:3,y1:0, x2:0,y2:3 },
        { x1:0,y1:1, x2:3,y2:1 },
        { x1:1,y1:0, x2:1,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:0, x2:3,y2:3 },
        { x1:0,y1:1, x2:3,y2:1 }
      ]
    },
    {
      id: 'L1-07', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:0,y2:3 },
        { x1:0,y1:0, x2:2,y2:0 },
        { x1:2,y1:0, x2:0,y2:2 },
        { x1:0,y1:2, x2:3,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:0, x2:0,y2:3 },
        { x1:0,y1:0, x2:2,y2:0 }
      ]
    },
    {
      id: 'L1-08', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:1, x2:3,y2:1 },
        { x1:1,y1:0, x2:1,y2:3 },
        { x1:1,y1:1, x2:3,y2:3 },
        { x1:2,y1:0, x2:3,y2:2 }
      ],
      hintLines: [
        { x1:0,y1:1, x2:3,y2:1 },
        { x1:1,y1:0, x2:1,y2:3 }
      ]
    },
    {
      id: 'L1-09', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:2, x2:2,y2:0 },
        { x1:2,y1:0, x2:3,y2:2 },
        { x1:3,y1:2, x2:1,y2:3 },
        { x1:0,y1:2, x2:0,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:2, x2:2,y2:0 },
        { x1:3,y1:2, x2:1,y2:3 }
      ]
    },
    {
      id: 'L1-10', level: 1, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:0,y2:3 },
        { x1:0,y1:0, x2:3,y2:3 },
        { x1:3,y1:0, x2:3,y2:3 },
        { x1:0,y1:3, x2:3,y2:3 }
      ],
      hintLines: [
        { x1:0,y1:0, x2:0,y2:3 },
        { x1:3,y1:0, x2:3,y2:3 }
      ]
    }
  ],

  /* ===================================================================
     LEVEL 2  4×4 グリッド / 4本 / ヒントなし
     ================================================================= */
  level2: [
    {
      id: 'L2-01', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:3,y2:3 },
        { x1:3,y1:0, x2:0,y2:3 },
        { x1:0,y1:1, x2:3,y2:1 },
        { x1:0,y1:2, x2:3,y2:2 }
      ],
      hintLines: []
    },
    {
      id: 'L2-02', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:1, x2:3,y2:0 },
        { x1:0,y1:1, x2:3,y2:3 },
        { x1:3,y1:0, x2:1,y2:2 },
        { x1:3,y1:3, x2:1,y2:2 }
      ],
      hintLines: []
    },
    {
      id: 'L2-03', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:3,y2:0 },
        { x1:0,y1:0, x2:0,y2:3 },
        { x1:0,y1:3, x2:2,y2:1 },
        { x1:2,y1:1, x2:3,y2:3 }
      ],
      hintLines: []
    },
    {
      id: 'L2-04', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:1,y1:0, x2:3,y2:0 },
        { x1:1,y1:0, x2:0,y2:2 },
        { x1:0,y1:2, x2:3,y2:2 },
        { x1:3,y1:2, x2:2,y2:3 }
      ],
      hintLines: []
    },
    {
      id: 'L2-05', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:3,y2:0 },
        { x1:0,y1:0, x2:3,y2:3 },
        { x1:3,y1:0, x2:0,y2:3 },
        { x1:0,y1:3, x2:3,y2:3 }
      ],
      hintLines: []
    },
    {
      id: 'L2-06', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:2, x2:3,y2:0 },
        { x1:3,y1:0, x2:3,y2:3 },
        { x1:3,y1:3, x2:0,y2:1 },
        { x1:0,y1:1, x2:0,y2:2 }
      ],
      hintLines: []
    },
    {
      id: 'L2-07', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:2,y2:3 },
        { x1:3,y1:0, x2:1,y2:3 },
        { x1:0,y1:2, x2:3,y2:2 },
        { x1:0,y1:1, x2:3,y2:1 }
      ],
      hintLines: []
    },
    {
      id: 'L2-08', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:0,y2:3 },
        { x1:0,y1:1, x2:3,y2:0 },
        { x1:0,y1:1, x2:3,y2:3 },
        { x1:0,y1:3, x2:3,y2:3 }
      ],
      hintLines: []
    },
    {
      id: 'L2-09', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:0, x2:1,y2:3 },
        { x1:1,y1:3, x2:2,y2:1 },
        { x1:2,y1:1, x2:3,y2:3 },
        { x1:0,y1:0, x2:3,y2:0 }
      ],
      hintLines: []
    },
    {
      id: 'L2-10', level: 2, grid: { cols: 4, rows: 4 },
      lines: [
        { x1:0,y1:3, x2:3,y2:0 },
        { x1:0,y1:0, x2:3,y2:3 },
        { x1:1,y1:2, x2:0,y2:3 },
        { x1:2,y1:1, x2:3,y2:0 }
      ],
      hintLines: []
    }
  ],

  /* ===================================================================
     LEVEL 3  5×5 グリッド / 5〜7本 / ヒントなし
     ================================================================= */
  level3: [
    {
      id: 'L3-01', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        { x1:0,y1:0, x2:4,y2:4 },
        { x1:4,y1:0, x2:0,y2:4 },
        { x1:2,y1:0, x2:2,y2:4 },
        { x1:0,y1:2, x2:4,y2:2 },
        { x1:0,y1:0, x2:4,y2:0 }
      ],
      hintLines: []
    },
    {
      id: 'L3-02', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        { x1:2,y1:0, x2:2,y2:4 },
        { x1:0,y1:2, x2:4,y2:2 },
        { x1:0,y1:0, x2:4,y2:4 },
        { x1:4,y1:0, x2:0,y2:4 },
        { x1:1,y1:1, x2:3,y2:3 }
      ],
      hintLines: []
    },
    {
      id: 'L3-03', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        { x1:0,y1:0, x2:4,y2:0 },
        { x1:4,y1:0, x2:0,y2:4 },
        { x1:0,y1:4, x2:4,y2:4 },
        { x1:0,y1:0, x2:0,y2:4 },
        { x1:2,y1:0, x2:2,y2:4 },
        { x1:0,y1:2, x2:4,y2:2 }
      ],
      hintLines: []
    },
    {
      id: 'L3-04', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        { x1:0,y1:2, x2:4,y2:2 },
        { x1:2,y1:0, x2:2,y2:4 },
        { x1:0,y1:0, x2:4,y2:4 },
        { x1:4,y1:0, x2:0,y2:4 },
        { x1:0,y1:0, x2:4,y2:0 },
        { x1:0,y1:4, x2:4,y2:4 }
      ],
      hintLines: []
    },
    {
      id: 'L3-05', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        { x1:1,y1:0, x2:3,y2:0 },
        { x1:3,y1:0, x2:4,y2:2 },
        { x1:4,y1:2, x2:3,y2:4 },
        { x1:3,y1:4, x2:1,y2:4 },
        { x1:1,y1:4, x2:0,y2:2 },
        { x1:0,y1:2, x2:1,y2:0 },
        { x1:1,y1:0, x2:3,y2:4 }
      ],
      hintLines: []
    },
    {
      id: 'L3-06', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        { x1:0,y1:0, x2:0,y2:4 },
        { x1:4,y1:0, x2:4,y2:4 },
        { x1:0,y1:2, x2:4,y2:2 },
        { x1:0,y1:0, x2:4,y2:4 },
        { x1:4,y1:0, x2:0,y2:4 }
      ],
      hintLines: []
    },
    {
      id: 'L3-07', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        { x1:0,y1:0, x2:4,y2:0 },
        { x1:4,y1:0, x2:0,y2:2 },
        { x1:0,y1:2, x2:4,y2:2 },
        { x1:4,y1:2, x2:0,y2:4 },
        { x1:0,y1:4, x2:4,y2:4 },
        { x1:2,y1:1, x2:2,y2:3 }
      ],
      hintLines: []
    },
    {
      id: 'L3-08', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        { x1:2,y1:0, x2:4,y2:2 },
        { x1:4,y1:2, x2:2,y2:4 },
        { x1:2,y1:4, x2:0,y2:2 },
        { x1:0,y1:2, x2:2,y2:0 },
        { x1:0,y1:1, x2:4,y2:3 },
        { x1:4,y1:1, x2:0,y2:3 }
      ],
      hintLines: []
    },
    {
      id: 'L3-09', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        { x1:0,y1:0, x2:0,y2:4 },
        { x1:0,y1:2, x2:4,y2:0 },
        { x1:0,y1:2, x2:4,y2:4 },
        { x1:0,y1:0, x2:4,y2:4 },
        { x1:0,y1:4, x2:4,y2:4 }
      ],
      hintLines: []
    },
    {
      id: 'L3-10', level: 3, grid: { cols: 5, rows: 5 },
      lines: [
        { x1:2,y1:0, x2:4,y2:2 },
        { x1:4,y1:2, x2:2,y2:4 },
        { x1:2,y1:4, x2:0,y2:2 },
        { x1:0,y1:2, x2:2,y2:0 },
        { x1:0,y1:0, x2:4,y2:4 },
        { x1:4,y1:0, x2:0,y2:4 }
      ],
      hintLines: []
    }
  ]
};

/* ============================================================
   指定レベルから5問をランダムにシャッフルして返す
   ============================================================ */
function getProblems(level) {
  const pool = PROBLEM_BANK[`level${level}`];
  if (!pool || pool.length === 0) return [];

  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const shuffled = [];
  while (shuffled.length < 5) shuffled.push(...arr);
  return shuffled.slice(0, 5);
}

/* ============================================================
   AIから受け取った問題データを正規化する
   ============================================================ */
function normalizeProblem(raw, level) {
  const gridSize = level === 3 ? 5 : 4;
  const maxCoord = gridSize - 1;
  const grid     = raw.grid || { cols: gridSize, rows: gridSize };

  const lines = (raw.lines || [])
    .map(l => ({
      x1: Math.min(Math.max(Math.round(Number(l.x1)), 0), maxCoord),
      y1: Math.min(Math.max(Math.round(Number(l.y1)), 0), maxCoord),
      x2: Math.min(Math.max(Math.round(Number(l.x2)), 0), maxCoord),
      y2: Math.min(Math.max(Math.round(Number(l.y2)), 0), maxCoord)
    }))
    .filter(l => !(l.x1 === l.x2 && l.y1 === l.y2));

  let hintLines = [];

  if (level === 0 && lines.length >= 4) {
    // Lv0: 直線系3本をヒントに、残り1本（斜め優先）をユーザー回答に
    const straight = lines.filter(l => l.x1 === l.x2 || l.y1 === l.y2);
    const diag     = lines.filter(l => l.x1 !== l.x2 && l.y1 !== l.y2);
    if (straight.length >= 3) {
      hintLines = straight.slice(0, 3);
    } else {
      // 直線が足りない場合は先頭3本をヒントに
      hintLines = lines.slice(0, 3);
    }
  } else if (level === 1 && lines.length >= 2) {
    // Lv1: 直線系2本をヒントに
    const straight = lines.filter(l => l.x1 === l.x2 || l.y1 === l.y2);
    if (straight.length >= 2) {
      hintLines = straight.slice(0, 2);
    } else {
      hintLines = lines.slice(0, 2);
    }
  }

  return {
    id: `AI-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    level,
    grid,
    lines,
    hintLines
  };
}
