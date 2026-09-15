/*
 * icons — original 24×24 stroke icon set (ARCHITECTURE.md §3, PLAN B2).
 *
 * Icons are described with a compact DSL: primitives separated by "|".
 *   "M…"            path data            "C cx cy r"        circle
 *   "E cx cy rx ry" ellipse              "R x y w h [rx]"   rounded rect
 * A leading "F" fills the primitive with currentColor (the stroke stays).
 *
 * API: get(name, { size = 16, title, className, strokeWidth }) → SVGElement
 *      svg(name, { size = 16, title, className, strokeWidth }) → static markup string (trusted)
 *      has(name) · list() · add(name, dsl)
 */
APB.define('icons', [], function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  const D = {
    /* tools */
    'select': 'M6 3.5l12.5 7-5.6 1.7-2.8 5.5z|M13 12.4l4.2 5.1',
    'hand': 'M8 13.5V6.8a1.5 1.5 0 0 1 3 0V11|M11 11V5.3a1.5 1.5 0 0 1 3 0V11|M14 11V6.8a1.5 1.5 0 0 1 3 0V14a6.5 6.5 0 0 1-6.5 6.5h-.6a5 5 0 0 1-4-2L3.2 14.6a1.5 1.5 0 0 1 2.3-1.9L8 15',
    'frame': 'M8 3v18M16 3v18M3 8h18M3 16h18',
    'section': 'M3 4.5h18M3 19.5h18|R5.5 8 13 8 1.5',
    'text': 'M5 6.5V4.5h14v2|M12 4.5v15|M9 19.5h6',
    'rect': 'R4 5 16 14 2',
    'ellipse': 'E12 12 8.5 7',
    'line': 'M5 19 19 5',
    'image': 'R3.5 4.5 17 15 2|C9 10 1.75|M20.5 15.5 16 11 6 19.5',
    'video': 'R3 6 13 12 2|M16 10.2l5-3v9.6l-5-3',
    'embed': 'R3 4 18 16 2|M3 8h18|M10 11.5 7.5 14l2.5 2.5M14 11.5l2.5 2.5-2.5 2.5',
    'icon': 'R3.5 3.5 17 17 4|M12 7.5l1.3 3.2 3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2L7.5 12l3.2-1.3z',
    'button': 'R3 7 18 10 5|M8 12h8',
    'link': 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1|M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    'list': 'M9 6h11M9 12h11M9 18h11|FC4.8 6 .9|FC4.8 12 .9|FC4.8 18 .9',
    'table': 'R3.5 4.5 17 15 2|M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10',
    'html': 'M8 7l-5 5 5 5M16 7l5 5-5 5|M13.5 5l-3 14',
    'divider': 'M3 12h18|M7 6.5h10M7 17.5h10',
    'spacer': 'M12 3v5M9.5 5.5 12 8l2.5-2.5|M12 21v-5M9.5 18.5 12 16l2.5 2.5|M4 12h16',
    'form': 'R4 3.5 16 17 2|M8 8h8M8 12h8M8 16h4',
    'input': 'R3 7 18 10 2|M7 10v4',
    'checkbox': 'R4 4 16 16 3|M8 12.5l2.5 2.5L16 9.5',
    'select-box': 'R3 7 18 10 2|M14 11l2 2 2-2',
    'details': 'R3 4 18 6.5 1.5|M15.5 6.4l1.5 1.5 1.5-1.5|M3 14.5h18M3 18.5h12',
    'component': 'M12 3l3 3-3 3-3-3z|M12 15l3 3-3 3-3-3z|M6 9l3 3-3 3-3-3z|M18 9l3 3-3 3-3-3z',
    'instance': 'M12 3.5 20.5 12 12 20.5 3.5 12z',
    'group': 'M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2|R7.5 7.5 5.5 5.5 1|R11 11 5.5 5.5 1',
    'page': 'M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z|M14 3v4.5h4.5',

    /* panels */
    'layers': 'M12 3.5 21 8l-9 4.5L3 8z|M3 12.2l9 4.5 9-4.5|M3 16.2l9 4.5 9-4.5',
    'insert': 'R3.5 3.5 17 17 3|M12 8v8M8 12h8',
    'pages': 'M15 3H8.5A1.5 1.5 0 0 0 7 4.5v12A1.5 1.5 0 0 0 8.5 18h9a1.5 1.5 0 0 0 1.5-1.5V7z|M15 3v4h4|M4 7.5v12A1.5 1.5 0 0 0 5.5 21H15',
    'assets': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M7 16.5l3-3 2 2 2-2 3 3',
    'design': 'M12 20.5 5.5 11 12 3.5l6.5 7.5z|M12 3.5v7|C12 12.5 1.5',
    'interact': 'M10 10l9.5 3.5-4.2 1.6-1.6 4.2z|M5 5l1.8 1.8M10 3v2.5M3 10h2.5M6.5 13.5l-1.8 1.8M13.5 6.5l1.8-1.8',
    'audit': 'M12 3l7.5 3v5.5c0 4.7-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.8-7.5-9.5V6z|M8.5 12l2.5 2.5 4.5-5',
    'ai': 'M10 3.5l1.6 4.4 4.4 1.6-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6z|M17.5 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z',
    'history': 'M3.5 12a8.5 8.5 0 1 0 2.5-6|M3.5 4v4.5H8|M12 7.5V12l3 2',
    'tokens': 'R3.5 3.5 7 7 1.5|C17 7 3.5|C7 17 3.5|M17 13.5l3.5 3.5-3.5 3.5-3.5-3.5z',

    /* edit & file */
    'undo': 'M9 14 4 9l5-5|M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    'redo': 'M15 14l5-5-5-5|M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
    'zoom-in': 'C10.5 10.5 6.5|M15.5 15.5l5 5|M8 10.5h5M10.5 8v5',
    'zoom-out': 'C10.5 10.5 6.5|M15.5 15.5l5 5|M8 10.5h5',
    'fit': 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5|R8.5 8.5 7 7 1',
    'preview': 'R3 4 18 16 2|M10 9v6l5-3z',
    'export': 'M12 14.5v-11|M8 7.5l4-4 4 4|M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5',
    'upload': 'M7.5 18.5H7a4.5 4.5 0 0 1-.7-8.95A6 6 0 0 1 17.8 8.6 4 4 0 0 1 17 18.5h-.5|M12 20.5v-8|M9 15l3-3 3 3',
    'save': 'M5 3.5h11l3.5 3.5v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z|M7.5 3.5v5h8v-5|M7.5 20.5v-6h9v6',
    'open': 'M3.5 18.5V6A1.5 1.5 0 0 1 5 4.5h4l2 2h7A1.5 1.5 0 0 1 19.5 8v2|M3.5 18.5l2.6-7a1.5 1.5 0 0 1 1.4-1h13.1a1 1 0 0 1 .95 1.3l-2.2 6.7a1.5 1.5 0 0 1-1.4 1z',
    'menu': 'M4 6.5h16M4 12h16M4 17.5h16',
    'more': 'FC5.5 12 1|FC12 12 1|FC18.5 12 1',
    'close': 'M6 6l12 12M18 6 6 18',
    'plus': 'M12 5v14M5 12h14',
    'minus': 'M5 12h14',
    'trash': 'M4 6.5h16|M9 6.5v-2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2|M6 6.5l1 13A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5l1-13|M10 10.5v6M14 10.5v6',
    'copy': 'R8.5 8.5 12 12 2|M15.5 8.5V5A1.5 1.5 0 0 0 14 3.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5',
    'cut': 'C6.5 17.5 2.5|C17.5 17.5 2.5|M8.3 15.7 18 4|M15.7 15.7 6 4',
    'paste': 'M9 4.5H6.5A1.5 1.5 0 0 0 5 6v13.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H15|R9 3 6 3.5 1',
    'duplicate': 'R8.5 8.5 12 12 2|M5.5 15.5H5A1.5 1.5 0 0 1 3.5 14V5A1.5 1.5 0 0 1 5 3.5h9A1.5 1.5 0 0 1 15.5 5v.5|M14.5 11.5v6M11.5 14.5h6',
    'lock': 'R5 10.5 14 10 2|M8 10.5v-3a4 4 0 0 1 8 0v3',
    'unlock': 'R5 10.5 14 10 2|M8 10.5v-3a4 4 0 0 1 7.75-1.4',
    'eye': 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z|C12 12 3',
    'eye-off': 'M10.6 5.6A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.4 3.2|M6.6 6.6C4 8.3 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 5.4-1.6|M9.9 9.9a3 3 0 0 0 4.2 4.2|M3 3l18 18',

    /* navigation */
    'chevron-down': 'M6 9l6 6 6-6',
    'chevron-right': 'M9 6l6 6-6 6',
    'chevron-left': 'M15 6l-6 6 6 6',
    'chevron-up': 'M6 15l6-6 6 6',
    'arrow-right': 'M4.5 12h15|M13.5 6l6 6-6 6',
    'arrow-left': 'M19.5 12h-15|M10.5 6l-6 6 6 6',
    'arrow-up': 'M12 19.5v-15|M6 10.5l6-6 6 6',
    'arrow-down': 'M12 4.5v15|M6 13.5l6 6 6-6',
    'search': 'C10.5 10.5 6.5|M15.5 15.5l5 5',
    'settings': 'M4 7h9M17 7h3M4 17h3M11 17h9|C15 7 2|C9 17 2',
    'external': 'M14 4h6v6|M20 4l-9 9|M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    'filter': 'M3.5 5h17l-6.5 8v5.5l-4 2V13z',
    'refresh': 'M20 11a8 8 0 0 0-14.3-4.3L4 8.5|M4 4v4.5h4.5|M4 13a8 8 0 0 0 14.3 4.3l1.7-1.8|M20 20v-4.5h-4.5',
    'grip': 'FC9 6 .9|FC15 6 .9|FC9 12 .9|FC15 12 .9|FC9 18 .9|FC15 18 .9',
    'command': 'M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9zm0 0h6m-6 0v6m6-6V6.5A2.5 2.5 0 1 1 17.5 9H15zm0 0v6m0 0h2.5a2.5 2.5 0 1 1-2.5 2.5V15zm0 0H9m0 0v2.5A2.5 2.5 0 1 1 6.5 15H9z',
    'keyboard': 'R2.5 6 19 12 2|M6.5 10h.01M9.8 10h.01M13.1 10h.01M16.5 10h.01|M8 14h8',

    /* theme & devices */
    'sun': 'C12 12 4|M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
    'moon': 'M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z',
    'monitor': 'R3 4 18 12 2|M8 20h8M12 16v4',
    'desktop': 'R2.5 3.5 19 13 1.5|M2.5 13.5h19|M9.5 20.5h5M12 16.5v4',
    'tablet': 'R5 3 14 18 2|M11 17.5h2',
    'mobile': 'R7 2.5 10 19 2|M11 18h2',

    /* arrange */
    'align-left': 'M4 3.5v17|R7 6.5 11 4 1|R7 13.5 7 4 1',
    'align-hcenter': 'M12 3.5v3M12 10.5v3M12 17.5v3|R6 6.5 12 4 1|R8.5 13.5 7 4 1',
    'align-right': 'M20 3.5v17|R6 6.5 11 4 1|R10 13.5 7 4 1',
    'align-top': 'M3.5 4h17|R6.5 7 4 11 1|R13.5 7 4 7 1',
    'align-vcenter': 'M3.5 12h3M10.5 12h3M17.5 12h3|R6.5 6 4 12 1|R13.5 8.5 4 7 1',
    'align-bottom': 'M3.5 20h17|R6.5 6 4 11 1|R13.5 10 4 7 1',
    'distribute-h': 'M4 3.5v17M20 3.5v17|R10 7 4 10 1',
    'distribute-v': 'M3.5 4h17M3.5 20h17|R7 10 10 4 1',
    'tidy': 'R4 4 5 5 1|R15 4 5 5 1|R4 15 5 5 1|R15 15 5 5 1|M11 6.5h2M11 17.5h2M6.5 11v2M17.5 11v2',
    'radial': 'C12 12 7|FC12 5 1.2|FC19 12 1.2|FC12 19 1.2|FC5 12 1.2',
    'rotate': 'M20 12a8 8 0 1 1-2.3-5.7|M20 4v4.5h-4.5',
    'bring-front': 'M4 13.5V5a1 1 0 0 1 1-1h8.5|FR8 8 12 12 1.5',
    'send-back': 'FM4 5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v3H9a1 1 0 0 0-1 1v7H5a1 1 0 0 1-1-1z|R8 8 12 12 1.5',
    'bring-forward': 'R5 13 14 7 1.5|M12 10.5v-7|M8.5 7 12 3.5 15.5 7',
    'send-backward': 'R5 4 14 7 1.5|M12 13.5v7|M8.5 17l3.5 3.5 3.5-3.5',
    'grid': 'R3.5 3.5 17 17 2|M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17',
    'layout-grid': 'R3.5 3.5 7 7 1.5|R13.5 3.5 7 7 1.5|R3.5 13.5 7 7 1.5|R13.5 13.5 7 7 1.5',
    'ruler': 'M3.5 16.5 16.5 3.5l4 4-13 13z|M7 13l2 2M10 10l2 2M13 7l2 2',
    'magnet': 'M5 4h4v8a3 3 0 0 0 6 0V4h4v8a7 7 0 0 1-14 0z|M5 8h4M15 8h4',

    /* status */
    'info': 'C12 12 9|M12 11v5.5|FC12 7.8 .6',
    'warning': 'M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z|M12 9.5V14|FC12 17.3 .6',
    'error': 'C12 12 9|M9 9l6 6M15 9l-6 6',
    'success': 'C12 12 9|M8 12.5l2.7 2.7L16 9.8',
    'help': 'C12 12 9|M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 3.8|M12 17h.01',
    'check': 'M5 12.5l4.5 4.5L19 7.5',

    /* typography */
    'text-align-left': 'M4 6h16M4 10h10M4 14h16M4 18h10',
    'text-align-center': 'M4 6h16M7 10h10M4 14h16M7 18h10',
    'text-align-right': 'M4 6h16M10 10h10M4 14h16M10 18h10',
    'text-align-justify': 'M4 6h16M4 10h16M4 14h16M4 18h16',
    'bold': 'M7 5h6a3.5 3.5 0 0 1 0 7H7z|M7 12h7a3.5 3.5 0 0 1 0 7H7z',
    'italic': 'M10 5h8M6 19h8|M14 5l-4 14',
    'underline': 'M7 4.5v6a5 5 0 0 0 10 0v-6|M5 20h14',
    'strikethrough': 'M4 12h16|M16.5 7.5C16 6 14.4 5 12 5c-2.5 0-4.3 1.3-4.3 3.2 0 1.4.8 2.3 2.3 2.8|M8 16.3c.5 1.7 2 2.7 4.2 2.7 2.6 0 4.3-1.4 4.3-3.3 0-.6-.1-1.2-.4-1.7',
    'type': 'M3 18.5 7.5 6.5 12 18.5|M4.7 14h5.6|C17.3 15.8 2.7|M20 12.5v6',

    /* layout & style */
    'stack-row': 'R3 7 5 10 1|R9.5 7 5 10 1|R16 7 5 10 1',
    'stack-column': 'R7 3 10 5 1|R7 9.5 10 5 1|R7 16 10 5 1',
    'wrap': 'M4 6h16|M4 12h13a3 3 0 0 1 0 6h-4|M15 16l-2 2 2 2|M4 18h5',
    'padding': 'R3.5 3.5 17 17 2|R8.5 8.5 7 7 1',
    'gap': 'R3.5 4 6 16 1.5|R14.5 4 6 16 1.5|M12 9v6',
    'sizing-fixed': 'M4 12h16|M4 8v8M20 8v8',
    'sizing-fill': 'M3.5 12h17|M7 8.5 3.5 12 7 15.5|M17 8.5l3.5 3.5-3.5 3.5',
    'sizing-hug': 'M3 12h6M15 12h6|M6.5 8.5 10 12l-3.5 3.5|M17.5 8.5 14 12l3.5 3.5',
    'border': 'M4 8V6a2 2 0 0 1 2-2h2M11 4h2M16 4h2a2 2 0 0 1 2 2v2M20 11v2M20 16v2a2 2 0 0 1-2 2h-2M13 20h-2M8 20H6a2 2 0 0 1-2-2v-2M4 13v-2',
    'radius': 'M4 20v-9a7 7 0 0 1 7-7h9',
    'shadow': 'R4 4 12 12 2|M20 8v10a2 2 0 0 1-2 2H8',
    'opacity': 'C12 12 8.5|FM12 3.5a8.5 8.5 0 0 1 0 17z',
    'blend': 'C9 12 5.5|C15 12 5.5',
    'code': 'M8.5 7.5 4 12l4.5 4.5|M15.5 7.5 20 12l-4.5 4.5',
    'image-off': 'M3.5 3.5l17 17|M20.5 16V6.5a2 2 0 0 0-2-2H9|M5 4.8a2 2 0 0 0-1.5 1.7v11a2 2 0 0 0 2 2h13|M3.5 15.5 8 11l3 3',
    'droplet': 'M12 3.5c3.3 4 6 7.3 6 10.5a6 6 0 0 1-12 0c0-3.2 2.7-6.5 6-10.5z',
    'palette': 'M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.9 1.8-1.8 0-1.3-1-1.6-1-2.7 0-.9.7-1.5 1.6-1.5h2.1a4 4 0 0 0 4-4c0-4-3.8-7-8.5-7z|FC7.5 11.5 .8|FC9.8 7.5 .8|FC14.5 7.5 .8',
    'sparkles': 'M9 4l1.4 3.6L14 9l-3.6 1.4L9 14l-1.4-3.6L4 9l3.6-1.4z|M17 3l.7 1.8 1.8.7-1.8.7L17 8l-.7-1.8-1.8-.7 1.8-.7z|M16.5 13.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z',
    'wand': 'M4 20 14.5 9.5|M13 8l1.5-1.5 3 3L16 11|M17.5 2.5v3M16 4h3|M7.5 3.5v2M6.5 4.5h2|M20 13v2M19 14h2',

    /* content glyphs */
    'star': 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
    'heart': 'M12 20s-7.5-4.4-8.9-9A4.6 4.6 0 0 1 12 7.1a4.6 4.6 0 0 1 8.9 3.9C19.5 15.6 12 20 12 20z',
    'mail': 'R3 5 18 14 2|M3.5 6.5 12 13l8.5-6.5',
    'phone': 'M5 3.5h3.2l1.6 4.3-2.1 1.3a11 11 0 0 0 6.7 6.7l1.3-2.1 4.3 1.6V19a1.5 1.5 0 0 1-1.5 1.5A15.5 15.5 0 0 1 3.5 5 1.5 1.5 0 0 1 5 3.5z',
    'map-pin': 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z|C12 10 2.25',
    'calendar': 'R3.5 5 17 15.5 2|M3.5 10h17|M8 3v4M16 3v4',
    'user': 'C12 8 4|M4.5 20.5a7.5 7.5 0 0 1 15 0',
    'users': 'C9 8 3.5|M2.5 20a6.5 6.5 0 0 1 13 0|M15.5 4.6a3.5 3.5 0 0 1 0 6.8|M18 14a6.5 6.5 0 0 1 3.5 6',
    'cart': 'M3 4h2.2l2.4 11.2a1.5 1.5 0 0 0 1.5 1.3h8.4a1.5 1.5 0 0 0 1.5-1.2L20.5 8H6.1|FC9.5 20 .8|FC17 20 .8',
    'globe': 'C12 12 8.5|M3.5 12h17|M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5z',
    'play': 'M7 4.5v15L19.5 12z',
    'pause': 'R6.5 5 3.5 14 1|R14 5 3.5 14 1'
  };

  const FALLBACK = 'R4.5 4.5 15 15 3|M9.8 9.6a2.3 2.3 0 0 1 4.4.8c0 1.5-2.2 2-2.2 3.3|M12 16.5h.01';

  const parsed = new Map();   // name -> [{ tag, attrs }]
  const markup = new Map();   // name -> inner markup string
  const templates = new Map(); // name -> SVGElement template (browser)
  const warned = new Set();

  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const nums = (s) => s.trim().split(/[\s,]+/).map(Number);

  function parseDSL(dsl) {
    return String(dsl).split('|').map((raw) => {
      let part = raw.trim();
      let fill = false;
      if (part[0] === 'F') { fill = true; part = part.slice(1).trim(); }
      const kind = part[0];
      let el;
      if (kind === 'C') {
        const [cx, cy, r] = nums(part.slice(1));
        el = { tag: 'circle', attrs: { cx, cy, r } };
      } else if (kind === 'E') {
        const [cx, cy, rx, ry] = nums(part.slice(1));
        el = { tag: 'ellipse', attrs: { cx, cy, rx, ry } };
      } else if (kind === 'R') {
        const [x, y, width, height, rx] = nums(part.slice(1));
        el = { tag: 'rect', attrs: { x, y, width, height } };
        if (rx) el.attrs.rx = rx;
      } else {
        el = { tag: 'path', attrs: { d: part } };
      }
      if (fill) el.attrs.fill = 'currentColor';
      return el;
    }).filter((el) => el.tag !== 'path' || el.attrs.d);
  }

  function resolveName(name) {
    const key = String(name || '');
    if (Object.prototype.hasOwnProperty.call(D, key)) return key;
    if (!warned.has(key)) {
      warned.add(key);
      if (typeof console !== 'undefined') console.warn('[APB icons] unknown icon "' + key + '" — using fallback glyph');
    }
    return null;
  }

  function primitives(name) {
    const key = name === null ? ' fallback' : name;
    if (!parsed.has(key)) parsed.set(key, parseDSL(name === null ? FALLBACK : D[name]));
    return parsed.get(key);
  }

  function innerMarkup(name) {
    const key = name === null ? ' fallback' : name;
    if (!markup.has(key)) {
      markup.set(key, primitives(name).map((p) =>
        '<' + p.tag + Object.keys(p.attrs).map((k) => ' ' + k + '="' + escAttr(p.attrs[k]) + '"').join('') + '/>').join(''));
    }
    return markup.get(key);
  }

  function template(name) {
    const key = name === null ? ' fallback' : name;
    let tpl = templates.get(key);
    if (!tpl) {
      tpl = document.createElementNS(NS, 'svg');
      tpl.setAttribute('xmlns', NS);
      tpl.setAttribute('viewBox', '0 0 24 24');
      tpl.setAttribute('fill', 'none');
      tpl.setAttribute('stroke', 'currentColor');
      tpl.setAttribute('stroke-width', '1.75');
      tpl.setAttribute('stroke-linecap', 'round');
      tpl.setAttribute('stroke-linejoin', 'round');
      tpl.setAttribute('focusable', 'false');
      for (const p of primitives(name)) {
        const child = document.createElementNS(NS, p.tag);
        for (const k of Object.keys(p.attrs)) child.setAttribute(k, String(p.attrs[k]));
        tpl.appendChild(child);
      }
      templates.set(key, tpl);
    }
    return tpl;
  }

  let titleSeq = 0;

  /** get(name, { size = 16, title, className, strokeWidth }) → SVGElement */
  function get(name, opts) {
    const o = opts || {};
    const resolved = resolveName(name);
    const el = template(resolved).cloneNode(true);
    const size = o.size == null ? 16 : o.size;
    el.setAttribute('width', String(size));
    el.setAttribute('height', String(size));
    el.setAttribute('class', 'apb-icon' + (o.className ? ' ' + o.className : ''));
    el.setAttribute('data-icon', resolved || 'fallback');
    if (o.strokeWidth) el.setAttribute('stroke-width', String(o.strokeWidth));
    if (o.title) {
      const t = document.createElementNS(NS, 'title');
      t.id = 'apb-icon-title-' + (++titleSeq);
      t.textContent = String(o.title);
      el.insertBefore(t, el.firstChild);
      el.setAttribute('role', 'img');
      el.setAttribute('aria-labelledby', t.id);
    } else {
      el.setAttribute('aria-hidden', 'true');
    }
    return el;
  }

  /** svg(name, { size = 16, title, className, strokeWidth }) → markup string (static, attribute values escaped). */
  function svg(name, opts) {
    const o = opts || {};
    const resolved = resolveName(name);
    const size = o.size == null ? 16 : Number(o.size) || 16;
    const a11y = o.title ? ' role="img" aria-label="' + escAttr(o.title) + '"' : ' aria-hidden="true"';
    const title = o.title ? '<title>' + escAttr(o.title) + '</title>' : '';
    return '<svg xmlns="' + NS + '" class="apb-icon' + (o.className ? ' ' + escAttr(o.className) : '') + '" width="' + size +
      '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
      (Number(o.strokeWidth) || 1.75) + '" stroke-linecap="round" stroke-linejoin="round" focusable="false"' + a11y + '>' +
      title + innerMarkup(resolved) + '</svg>';
  }

  function has(name) {
    return Object.prototype.hasOwnProperty.call(D, String(name));
  }

  function list() {
    return Object.keys(D).sort();
  }

  /** add(name, dsl) — register an extra icon (plugins). Existing names are not replaced. */
  function add(name, dsl) {
    const key = String(name || '');
    if (!key || has(key) || typeof dsl !== 'string') return false;
    D[key] = dsl;
    warned.delete(key);
    return true;
  }

  return { get, svg, has, list, add };
});
