/**
 * TEMPORARY diagnostic script -- not part of the app. Logs every element
 * whose bounding rect extends past the right edge of the viewport or
 * before the left edge, on load and on demand via window.__checkOverflow().
 * Remove this file and its <script> tag in index.html once the overflow
 * investigation is done.
 */
(function () {
    function checkOverflow(label) {
        const vw = document.documentElement.clientWidth;
        const offenders = [];
        document.querySelectorAll('*').forEach((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;
            if (rect.right > vw + 0.5 || rect.left < -0.5) {
                offenders.push({ el, rect });
            }
        });

        console.log(`[OVERFLOW CHECK]${label ? ' ' + label : ''} viewport=${vw}px scrollWidth=${document.documentElement.scrollWidth}px offenders=${offenders.length}`);
        offenders.forEach(({ el, rect }) => {
            const classAttr = typeof el.className === 'string' ? el.className : '';
            const selector = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${classAttr ? '.' + classAttr.trim().split(/\s+/).join('.') : ''}`;
            console.log(
                `[OVERFLOW] ${selector} left=${rect.left.toFixed(1)} right=${rect.right.toFixed(1)} width=${rect.width.toFixed(1)}` +
                    ` overflowRight=${(rect.right - vw).toFixed(1)} overflowLeft=${(-rect.left).toFixed(1)}`
            );
        });
        return offenders.map(({ el, rect }) => ({
            tag: el.tagName,
            id: el.id || null,
            className: typeof el.className === 'string' ? el.className : null,
            left: rect.left,
            right: rect.right,
            width: rect.width
        }));
    }

    window.__checkOverflow = checkOverflow;
    window.addEventListener('load', () => setTimeout(() => checkOverflow('(window load)'), 500));
})();
