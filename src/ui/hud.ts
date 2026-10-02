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
  private banner: HTMLElement;
  private caption: HTMLElement;
  private captionTitle: HTMLElement;
  private captionSub: HTMLElement;
  private last = { h: -1, a: -1, min: -1, banner: '', caption: '' };
  private captionUntil = 0;

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
      </div>
      <div class="banner"></div>
      <div class="caption"><div class="c-title"></div><div class="c-sub"></div></div>
    `;
    parent.appendChild(this.root);
    this.homeScore = this.root.querySelector('.hs')!;
    this.awayScore = this.root.querySelector('.as')!;
    this.clock = this.root.querySelector('.clock')!;
    this.banner = this.root.querySelector('.banner')!;
    this.caption = this.root.querySelector('.caption')!;
    this.captionTitle = this.root.querySelector('.c-title')!;
    this.captionSub = this.root.querySelector('.c-sub')!;
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
    const [h, a] = m.teams;
    if (h.score !== this.last.h) {
      this.homeScore.textContent = String(h.score);
      this.last.h = h.score;
    }
    if (a.score !== this.last.a) {
      this.awayScore.textContent = String(a.score);
      this.last.a = a.score;
    }
    const min = Math.min(m.displayMinute, m.half === 1 ? 45 : 90);
    if (min !== this.last.min) {
      this.clock.textContent = `${min}'`;
      this.last.min = min;
    }
    let banner = '';
    if (m.phase === 'setpiece' && m.setPiece) {
      const k = m.setPiece.kind;
      const mine = m.setPiece.team === m.humanTeam;
      banner =
        k === 'corner' ? 'Corner'
        : k === 'throw' ? 'Throw-in'
        : k === 'goalkick' ? 'Goal kick'
        : k === 'penalty' ? (mine ? 'Penalty · aim with the stick · hold Shoot' : 'Penalty')
        : k === 'freekick' ? (mine && m.setPiece.direct ? 'Free kick · Shoot: over the wall · Pass / Lob: play it' : 'Free kick')
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
