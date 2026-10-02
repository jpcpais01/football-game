import type { Match } from '../sim/match';

function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

/** Scoreboard + big moment captions. DOM only, updated only when something changes. */
export class Hud {
  private root: HTMLElement;
  private homeScore: HTMLElement;
  private awayScore: HTMLElement;
  private clock: HTMLElement;
  /** The fourth official's board: +N, up once the half reaches 45' or 90'. */
  private added: HTMLElement;
  private banner: HTMLElement;
  private caption: HTMLElement;
  private captionTitle: HTMLElement;
  private captionSub: HTMLElement;
  private last = { h: -1, a: -1, clock: '', banner: '', caption: '' };
  private captionUntil = 0;
  private card: HTMLElement;
  /** Score shown until the goal's score card reveals the new one. */
  private held: [number, number] | null = null;
  /** Pending score card; `at` is seconds into the goal phase. */
  private reveal: { at: number; team: number; line: string } | null = null;
  private cardUntil = 0;

  constructor(parent: HTMLElement, match: Match) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    const [h, a] = match.teams;
    this.root.innerHTML = `
      <div class="scoreboard">
        <div class="team home"><i style="background:${hex(h.info.kit.shirt)}"></i><span>${h.info.short}</span></div>
        <div class="score"><b class="hs">0</b><em>–</em><b class="as">0</b></div>
        <div class="team away"><span>${a.info.short}</span><i style="background:${hex(a.info.kit.shirt)}"></i></div>
        <div class="clock">0'</div>
        <div class="added"></div>
      </div>
      <div class="banner"></div>
      <div class="caption"><div class="c-title"></div><div class="c-sub"></div></div>
      <div class="scorecard">
        <div class="sc-row">
          <div class="sc-team home" style="--c:${hex(h.info.kit.shirt)}"><i></i><span>${h.info.short}</span></div>
          <div class="sc-num home"><b class="old">0</b><b class="new">0</b></div>
          <em>–</em>
          <div class="sc-num away"><b class="old">0</b><b class="new">0</b></div>
          <div class="sc-team away" style="--c:${hex(a.info.kit.shirt)}"><span>${a.info.short}</span><i></i></div>
        </div>
        <div class="sc-line"></div>
      </div>
    `;
    parent.appendChild(this.root);
    this.homeScore = this.root.querySelector('.hs')!;
    this.awayScore = this.root.querySelector('.as')!;
    this.clock = this.root.querySelector('.clock')!;
    this.added = this.root.querySelector('.added')!;
    this.banner = this.root.querySelector('.banner')!;
    this.caption = this.root.querySelector('.caption')!;
    this.captionTitle = this.root.querySelector('.c-title')!;
    this.captionSub = this.root.querySelector('.c-sub')!;
    this.card = this.root.querySelector('.scorecard')!;
  }

  /**
   * A goal: keep the old score up through the celebration, then reveal the new one on a
   * score card as the camera comes back to the field.
   */
  goal(m: Match, team: number, revealAt: number): void {
    const [h, a] = m.teams;
    this.held = [h.score - (team === 0 ? 1 : 0), a.score - (team === 1 ? 1 : 0)];
    const s = m.scorer;
    this.reveal = { at: revealAt, team, line: `${s ? (s.name ? s.name.split(' ').slice(-1)[0] : '#' + (s.index + 1)) + ' · ' : ''}${m.teams[team].info.name} · ${m.clockLabel}` };
  }

  private showCard(m: Match, team: number, line: string, now: number): void {
    const old = this.held ?? [m.teams[0].score, m.teams[1].score];
    const nums = this.card.querySelectorAll<HTMLElement>('.sc-num');
    [0, 1].forEach((i) => {
      const n = nums[i];
      n.querySelector('.old')!.textContent = String(old[i]);
      n.querySelector('.new')!.textContent = String(m.teams[i].score);
      n.classList.toggle('roll', i === team);
    });
    this.card.querySelector('.sc-line')!.textContent = line;
    this.card.classList.remove('show');
    void this.card.offsetWidth; // restart the animation
    this.card.classList.add('show');
    this.cardUntil = now + 3.4;
  }

  /** New match, maybe new teams: refresh names and colours. */
  setTeams(match: Match): void {
    const [h, a] = match.teams;
    const home = this.root.querySelector('.home')!;
    const away = this.root.querySelector('.away')!;
    home.querySelector('span')!.textContent = h.info.short;
    (home.querySelector('i') as HTMLElement).style.background = hex(h.info.kit.shirt);
    away.querySelector('span')!.textContent = a.info.short;
    (away.querySelector('i') as HTMLElement).style.background = hex(a.info.kit.shirt);
    this.last.h = this.last.a = -1;
    this.last.clock = '';
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  /** `variant`: '' (big moment), 'small' (a call: foul, advantage), 'yellow' (a booking). */
  showCaption(title: string, sub: string, seconds: number, now: number, variant: '' | 'small' | 'yellow' = ''): void {
    this.captionTitle.textContent = title;
    this.captionSub.textContent = sub;
    this.caption.classList.remove('show', 'small', 'yellow');
    if (variant) this.caption.classList.add(variant);
    void this.caption.offsetWidth; // restart the animation
    this.caption.classList.add('show');
    this.captionUntil = now + seconds;
  }

  update(m: Match, now: number): void {
    // Revealed on the goal sequence's own clock (so pausing doesn't spoil it).
    if (this.reveal && (m.phase !== 'goal' || m.phaseT >= this.reveal.at)) {
      this.showCard(m, this.reveal.team, this.reveal.line, now);
      this.reveal = null;
      this.held = null;
    }
    if (this.cardUntil > 0 && now > this.cardUntil) {
      this.card.classList.remove('show');
      this.cardUntil = 0;
    }
    const hs = this.held ? this.held[0] : m.teams[0].score;
    const as = this.held ? this.held[1] : m.teams[1].score;
    if (hs !== this.last.h) {
      this.homeScore.textContent = String(hs);
      this.last.h = hs;
    }
    if (as !== this.last.a) {
      this.awayScore.textContent = String(as);
      this.last.a = as;
    }
    const label = m.clockLabel;
    if (label !== this.last.clock) {
      this.clock.textContent = label;
      const board = label.includes('+');
      this.added.textContent = board ? `+${m.addedTime}` : '';
      this.added.classList.toggle('show', board);
      this.last.clock = label;
    }
    let banner = '';
    if (m.phase === 'setpiece' && m.setPiece) {
      const k = m.setPiece.kind;
      const mine = m.setPiece.team === m.humanTeam;
      banner =
        k === 'corner' ? (mine ? 'Corner · Stick: aim · Pass: whip · Shoot: float · Through: short' : 'Corner')
        : k === 'throw' ? 'Throw-in'
        : k === 'goalkick' ? 'Goal kick'
        : k === 'penalty' ? (mine ? 'Penalty · Stick: aim · Hold Shoot' : 'Penalty')
        : k === 'freekick' ? (mine && m.setPiece.direct ? 'Stick: aim · Hold Shoot · Pass: play it' : 'Free kick')
        : '';
    } else if (m.phase === 'kickoff' && m.setPiece && m.setPiece.team === m.humanTeam && m.setPiece.t > 1.2) {
      banner = 'Pass to kick off';
    }
    if (banner !== this.last.banner) {
      this.banner.textContent = banner;
      this.banner.classList.toggle('show', banner !== '');
      this.last.banner = banner;
    }
    if (this.captionUntil > 0 && now > this.captionUntil) {
      this.caption.classList.remove('show');
      this.captionUntil = 0;
    }
  }
}
