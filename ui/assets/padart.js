// Pictures of the controllers, drawn to look like the real things. PadArt.svg(controller) returns an <svg> string.
// Every picture is in a 400 x 260 box except the Wii Remote and the Joy-Cons, which have their own shapes.
(function (root) {
    const dot = (x, y, r, fill, extra = '') => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" ${extra}/>`;
    const pill = (x, y, w, h, fill, extra = '') => `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${Math.min(w, h) / 2}" fill="${fill}" ${extra}/>`;
    const cross = (x, y, arm, thick, fill) => `<path fill="${fill}" d="M${x - thick / 2} ${y - arm} h${thick} v${arm - thick / 2} h${arm - thick / 2} v${thick} h${-(arm - thick / 2)} v${arm - thick / 2} h${-thick} v${-(arm - thick / 2)} h${-(arm - thick / 2)} v${-thick} h${arm - thick / 2} z"/>`;
    const gloss = (path, opacity = 0.22) => `<path d="${path}" fill="url(#gl)" opacity="${opacity}"/>`;
    const defs = `<defs><linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`;
    const svg = (box, inner) => `<svg viewBox="${box}" xmlns="http://www.w3.org/2000/svg">${defs}${inner}</svg>`;

    // Two different bodies: the Xbox is wider with grips that angle out, the Switch Pro Controller is rounder with short thick grips
    const XBOX_BODY = 'M98 80 C140 66 260 66 302 80 C330 90 348 130 358 182 C365 222 350 244 331 238 C314 232 306 208 284 198 L116 198 C94 208 86 232 69 238 C50 244 35 222 42 182 C52 130 70 90 98 80 Z';
    const PRO_BODY = 'M106 82 C144 70 256 70 294 82 C322 90 342 128 350 176 C356 214 346 238 326 234 C308 230 304 210 282 202 L118 202 C96 210 92 230 74 234 C54 238 44 214 50 176 C58 128 78 90 106 82 Z';
    // One bumper per shoulder: a slim curved bar that follows the top edge, partly under the body
    const bumper = (side, fill) => side === 'L'
        ? `<path d="M68 112 C80 86 116 70 160 68" stroke="${fill}" stroke-width="13" fill="none" stroke-linecap="round"/>`
        : `<path d="M332 112 C320 86 284 70 240 68" stroke="${fill}" stroke-width="13" fill="none" stroke-linecap="round"/>`;

    function xbox() {
        const w = '#f1f3f5', edge = '#b4bcc4', dark = '#4b545d';
        return svg('0 20 400 250', `
            ${bumper('L', '#9aa5b0')}${bumper('R', '#9aa5b0')}
            <path d="${XBOX_BODY}" fill="${w}" stroke="${edge}" stroke-width="5"/>${gloss(XBOX_BODY)}
            ${dot(112, 112, 27, '#cfd5db')}${dot(112, 112, 20, dark)}${dot(112, 112, 12, '#2e353c')}
            ${cross(158, 168, 24, 17, dark)}
            ${dot(244, 168, 27, '#cfd5db')}${dot(244, 168, 20, dark)}${dot(244, 168, 12, '#2e353c')}
            ${dot(200, 100, 14, '#d6dce2')}${dot(200, 100, 10, '#59b86a')}
            ${pill(168, 118, 20, 9, dark)}${pill(232, 118, 20, 9, dark)}
            ${dot(290, 140, 11, '#6cbf3e')}${dot(312, 116, 11, '#e0453a')}${dot(268, 116, 11, '#2f7fd8')}${dot(290, 92, 11, '#f2c230')}`);
    }

    function proController() {
        const body = '#585f66', edge = '#363c42', dark = '#2a2f34';
        return svg('0 20 400 250', `
            ${bumper('L', '#3b4147')}${bumper('R', '#3b4147')}
            <path d="${PRO_BODY}" fill="${body}" stroke="${edge}" stroke-width="5"/>${gloss(PRO_BODY, 0.16)}
            ${dot(112, 112, 27, '#40464c')}${dot(112, 112, 19, '#1f2327')}${dot(112, 112, 11, '#7b838b')}
            ${cross(158, 170, 22, 15, dark)}
            ${dot(244, 170, 27, '#40464c')}${dot(244, 170, 19, '#1f2327')}${dot(244, 170, 11, '#7b838b')}
            ${pill(176, 96, 22, 8, '#c8ced3')}${cross(236, 96, 7, 4, '#c8ced3')}
            ${dot(224, 120, 8, '#c8ced3')}<rect x="170" y="114" width="12" height="12" rx="3" fill="#c8ced3"/>
            ${dot(290, 140, 11, '#e9edf0')}${dot(312, 116, 11, '#e9edf0')}${dot(268, 116, 11, '#e9edf0')}${dot(290, 92, 11, '#e9edf0')}`);
    }

    function gamecube() {
        const body = '#6a52b8', edge = '#463189';
        const shape = 'M110 70 C150 56 250 56 290 70 C326 78 350 118 366 170 C376 206 372 246 350 250 C330 254 316 232 298 214 C286 202 272 200 252 200 L148 200 C128 200 114 202 102 214 C84 232 70 254 50 250 C28 246 24 206 34 170 C50 118 74 78 110 70 Z';
        return svg('0 20 400 250', `
            <path d="M84 84 C90 56 120 42 154 42" stroke="#8c8fa0" stroke-width="15" fill="none" stroke-linecap="round"/>
            <path d="M316 84 C310 56 280 42 246 42" stroke="#8c8fa0" stroke-width="15" fill="none" stroke-linecap="round"/>
            <path d="${shape}" fill="${body}" stroke="${edge}" stroke-width="5"/>${gloss(shape, 0.2)}
            ${dot(104, 120, 27, '#c9ccd6')}${dot(104, 120, 20, '#9a9eab')}${dot(104, 120, 12, '#c9ccd6')}
            ${cross(150, 180, 20, 13, '#c9ccd6')}
            ${dot(200, 120, 9, '#c9ccd6')}
            ${dot(300, 128, 28, '#39b46b')}${dot(300, 128, 18, '#52cd85', 'opacity=".55"')}
            ${dot(262, 150, 11, '#e0453a')}
            <ellipse cx="346" cy="134" rx="9" ry="19" transform="rotate(-30 346 134)" fill="#c9ccd6"/>
            <ellipse cx="300" cy="86" rx="19" ry="9" transform="rotate(-14 300 86)" fill="#c9ccd6"/>
            ${dot(244, 178, 18, '#e9d24a')}${dot(244, 178, 11, '#c9b02e')}`);
    }

    function wiimote() {
        // Lying on its side: the pointing end (IR window) on the right
        return `<svg viewBox="10 70 460 120" xmlns="http://www.w3.org/2000/svg">${defs}
            <rect x="20" y="82" width="440" height="96" rx="44" fill="#f7f8fa" stroke="#bcc4cc" stroke-width="5"/>
            <rect x="20" y="82" width="440" height="48" rx="44" fill="url(#gl)" opacity=".7"/>
            <rect x="430" y="108" width="22" height="44" rx="11" fill="#2e353c"/>
            ${dot(52, 130, 11, '#e6eaee', 'stroke="#bcc4cc" stroke-width="3"')}${dot(52, 130, 4, '#59b86a')}
            ${cross(112, 130, 24, 17, '#c9d0d7')}
            ${pill(204, 130, 52, 40, '#e7ebef', 'stroke="#c9d0d7" stroke-width="3"')}${dot(204, 130, 7, '#c9d0d7')}
            ${dot(262, 130, 8, '#3ab4f2')}${pill(248, 130, 4, 4, '#fff')}
            ${pill(286, 130, 14, 7, '#c9d0d7')}${dot(318, 130, 8, '#d9dfe5', 'stroke="#c9d0d7" stroke-width="2"')}${cross(348, 130, 7, 4, '#c9d0d7')}
            ${dot(380, 130, 11, '#e6eaee', 'stroke="#c9d0d7" stroke-width="3"')}${dot(406, 130, 11, '#e6eaee', 'stroke="#c9d0d7" stroke-width="3"')}
            <g fill="#3ab4f2"><circle cx="438" cy="164" r="4"/><circle cx="426" cy="164" r="4" opacity=".3"/><circle cx="414" cy="164" r="4" opacity=".3"/><circle cx="402" cy="164" r="4" opacity=".3"/></g></svg>`;
    }

    // One Joy-Con, upright, drawn into its own offset so two can stand side by side
    function joycon(side, dx = 0) {
        const left = side === 'L';
        const color = left ? '#0ab9e6' : '#ff4554';
        const edgeC = left ? '#0690b3' : '#cc2b39';
        const rail = '#2d3238';
        // The outer side is rounded; the inner side is flat with the rail the controller slides on
        const body = left
            ? `M${dx + 52} 24 C${dx + 30} 24 ${dx + 22} 40 ${dx + 22} 64 L${dx + 22} 196 C${dx + 22} 220 ${dx + 36} 236 ${dx + 58} 236 L${dx + 78} 236 L${dx + 78} 24 Z`
            : `M${dx + 48} 24 C${dx + 70} 24 ${dx + 78} 40 ${dx + 78} 64 L${dx + 78} 196 C${dx + 78} 220 ${dx + 64} 236 ${dx + 42} 236 L${dx + 22} 236 L${dx + 22} 24 Z`;
        const railX = left ? dx + 72 : dx + 22;
        const bump = left ? `<path d="M${dx + 28} 40 C${dx + 34} 22 ${dx + 52} 18 ${dx + 70} 20" stroke="#2f3a44" stroke-width="9" fill="none" stroke-linecap="round" opacity=".55"/>`
            : `<path d="M${dx + 72} 40 C${dx + 66} 22 ${dx + 48} 18 ${dx + 30} 20" stroke="#2f3a44" stroke-width="9" fill="none" stroke-linecap="round" opacity=".55"/>`;
        const cx = dx + 50;
        let parts;
        if (left) {
            parts = `${dot(cx - 4, 74, 15, '#222a30')}${dot(cx - 4, 74, 9, '#5a646d')}
                ${pill(cx + 14, 40, 14, 5, '#222a30')}
                ${dot(cx - 22, 152, 8, '#222a30')}${dot(cx - 4, 134, 8, '#222a30')}${dot(cx - 4, 170, 8, '#222a30')}${dot(cx + 14, 152, 8, '#222a30')}
                <rect x="${cx - 22}" y="204" width="13" height="13" rx="3" fill="#222a30"/>`;
        } else {
            parts = `${dot(cx + 4, 152, 15, '#222a30')}${dot(cx + 4, 152, 9, '#5a646d')}
                ${cross(cx - 12, 40, 6, 3.5, '#222a30')}
                ${dot(cx + 4, 70, 8, '#222a30')}${dot(cx - 14, 88, 8, '#222a30')}${dot(cx + 4, 106, 8, '#222a30')}${dot(cx + 22, 88, 8, '#222a30')}
                ${dot(cx - 4, 208, 7, '#222a30')}`;
        }
        return `<path d="${body}" fill="${color}" stroke="${edgeC}" stroke-width="4"/>${gloss(body, 0.25)}
            <rect x="${railX}" y="28" width="6" height="204" rx="3" fill="${rail}"/>${bump}${parts}`;
    }

    function joyconSingle(side) { return svg('0 10 100 240', joycon(side, 0)); }
    function joyconPair() { return svg('10 10 200 240', joycon('L', 0) + joycon('R', 100)); }

    // Any other gamepad: the classic symmetric layout, d-pad and buttons high, two sticks side by side below the middle
    const generic = () => {
        const body = '#dfe4e9', edge = '#a9b3bd', dark = '#59636d';
        const shape = 'M92 84 C140 70 260 70 308 84 C338 92 356 132 366 184 C373 224 356 246 334 240 C318 235 312 214 292 206 C272 198 252 214 200 214 C148 214 128 198 108 206 C88 214 82 235 66 240 C44 246 27 224 34 184 C44 132 62 92 92 84 Z';
        return svg('0 20 400 250', `
            ${bumper('L', '#a9b3bd')}${bumper('R', '#a9b3bd')}
            <path d="${shape}" fill="${body}" stroke="${edge}" stroke-width="5"/>${gloss(shape)}
            ${cross(104, 128, 24, 17, dark)}
            ${dot(296, 130, 9, dark)}${dot(318, 108, 9, dark)}${dot(274, 108, 9, dark)}${dot(296, 86, 9, dark)}
            ${dot(162, 168, 22, '#b8c1ca')}${dot(162, 168, 15, dark)}${dot(238, 168, 22, '#b8c1ca')}${dot(238, 168, 15, dark)}
            ${pill(184, 118, 18, 8, dark)}${pill(216, 118, 18, 8, dark)}`);
    };

    function kindOf(c) {
        const kind = typeof c === 'string' ? c : c.kind;
        const name = typeof c === 'string' ? '' : String(c.name || '');
        if (kind === 'switch') {
            if (typeof c !== 'string' && c.combined) return 'joycon-pair';
            if (/combined|joy-?con pair|\(l\/r\)/i.test(name)) return 'joycon-pair';
            if (/\(l\)|left joy-?con/i.test(name)) return 'joycon-l';
            if (/\(r\)|right joy-?con/i.test(name)) return 'joycon-r';
            return 'switch';
        }
        return kind;
    }

    function art(c) {
        switch (kindOf(c)) {
            case 'wiimote': return wiimote();
            case 'gamecube': return gamecube();
            case 'switch': return proController();
            case 'joycon-l': return joyconSingle('L');
            case 'joycon-r': return joyconSingle('R');
            case 'joycon-pair': return joyconPair();
            case 'xbox': return xbox();
            default: return generic();
        }
    }

    const api = { svg: art, kindOf };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.PadArt = api;
})(typeof window !== 'undefined' ? window : globalThis);
