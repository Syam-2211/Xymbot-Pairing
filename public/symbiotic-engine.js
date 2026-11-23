/**
 * Symbiotic Watercolor Fluid Engine
 * Provides an organic fluid pigment bleed, bleeding ink tendrils,
 * paper capillary diffusion, and interactive organic ripple on actions.
 */

(function (global) {
    const SymbioticWatercolor = {
        init(options = {}) {
            const canvas = document.getElementById(options.canvasId || 'symbiote-canvas');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            const toggleBtn = document.getElementById(options.toggleId || 'theme-toggle');
            const themeLabel = document.getElementById(options.labelId || 'theme-label');

            let width, height;
            let dpr = Math.min(window.devicePixelRatio || 1, 2);

            function resize() {
                width = window.innerWidth;
                height = window.innerHeight;
                canvas.width = width * dpr;
                canvas.height = height * dpr;
                canvas.style.width = width + 'px';
                canvas.style.height = height + 'px';
                ctx.scale(dpr, dpr);
            }
            window.addEventListener('resize', resize);
            resize();

            // Simplex-style organic pseudo-noise for fractal paper fluid bleed
            function noise(x, y, t = 0) {
                return (
                    Math.sin(x * 0.015 + t * 0.002) * Math.cos(y * 0.015 + t * 0.003) +
                    Math.sin(x * 0.038 - y * 0.032 + t * 0.005) * 0.5 +
                    Math.cos(x * 0.082 + y * 0.076) * 0.25
                );
            }

            const savedTheme = localStorage.getItem('xymbot_theme') ||
                (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

            function applyTheme(theme, animate = false, originX = width / 2, originY = height / 2) {
                if (animate) {
                    triggerWatercolorFluidTransition(theme, originX, originY, () => {
                        document.documentElement.setAttribute('data-theme', theme);
                        localStorage.setItem('xymbot_theme', theme);
                        if (themeLabel) {
                            themeLabel.textContent = theme === 'dark' ? 'Dark Symbiote' : 'Light Symbiote';
                        }
                    });
                } else {
                    document.documentElement.setAttribute('data-theme', theme);
                    localStorage.setItem('xymbot_theme', theme);
                    if (themeLabel) {
                        themeLabel.textContent = theme === 'dark' ? 'Dark Symbiote' : 'Light Symbiote';
                    }
                }
            }

            /* ─── WATERCOLOR FLUID PIGMENT BLOBS (Symbiotic Bleed) ─── */
            class FluidDrop {
                constructor(x, y, color, baseR, growthRate, life, wobbleFreq) {
                    this.x = x;
                    this.y = y;
                    this.color = color;
                    this.baseR = baseR;
                    this.currentR = 0;
                    this.targetR = baseR;
                    this.growthRate = growthRate;
                    this.life = life;
                    this.maxLife = life;
                    this.wobbleFreq = wobbleFreq;
                    this.seed = Math.random() * 100;
                    this.points = 48;
                    this.offsets = new Float32Array(this.points);
                    for (let i = 0; i < this.points; i++) {
                        this.offsets[i] = (Math.random() - 0.5) * 0.55;
                    }
                }

                update(t) {
                    if (this.currentR < this.targetR) {
                        this.currentR += (this.targetR - this.currentR) * this.growthRate;
                    }
                    this.life--;
                }

                draw(ctx, t, globalAlpha = 1) {
                    const progress = 1 - (this.life / this.maxLife);
                    const alpha = Math.sin(Math.PI * Math.min(progress * 1.4, 1)) * globalAlpha;
                    if (alpha <= 0.01) return;

                    ctx.save();
                    ctx.globalAlpha = Math.min(alpha, 0.95);
                    ctx.fillStyle = this.color;
                    ctx.beginPath();

                    for (let i = 0; i <= this.points; i++) {
                        const idx = i % this.points;
                        const angle = (idx / this.points) * Math.PI * 2;
                        // Simulating fibrous watercolor paper absorption
                        const fiberNoise = noise(
                            this.x + Math.cos(angle) * this.currentR * 1.5,
                            this.y + Math.sin(angle) * this.currentR * 1.5,
                            t + this.seed
                        );
                        const r = this.currentR * (1 + this.offsets[idx] * 0.35 + fiberNoise * 0.45);
                        const px = this.x + Math.cos(angle) * r;
                        const py = this.y + Math.sin(angle) * r;

                        if (i === 0) ctx.moveTo(px, py);
                        else ctx.lineTo(px, py);
                    }

                    ctx.closePath();
                    ctx.fill();
                    ctx.restore();
                }
            }

            /* ─── CAPILLARY INK TENDRIL (Symbiotic Vein) ─── */
            class CapillaryVein {
                constructor(x, y, angle, length, width, color) {
                    this.x = x;
                    this.y = y;
                    this.angle = angle;
                    this.length = length;
                    this.currentL = 0;
                    this.width = width;
                    this.color = color;
                    this.speed = 12 + Math.random() * 14;
                    this.curve = (Math.random() - 0.5) * 0.12;
                    this.points = [{ x, y }];
                    this.branches = [];
                    this.done = false;
                }

                grow() {
                    if (this.currentL >= this.length) {
                        this.done = true;
                        return;
                    }
                    this.currentL += this.speed;
                    this.angle += this.curve;
                    const nextX = this.points[this.points.length - 1].x + Math.cos(this.angle) * this.speed;
                    const nextY = this.points[this.points.length - 1].y + Math.sin(this.angle) * this.speed;
                    this.points.push({ x: nextX, y: nextY });

                    // Natural capillary dendritic splitting
                    if (Math.random() < 0.1 && this.branches.length < 3 && this.width > 2) {
                        const branchAngle = this.angle + (Math.random() > 0.5 ? 0.6 : -0.6);
                        this.branches.push(new CapillaryVein(nextX, nextY, branchAngle, this.length * 0.5, this.width * 0.65, this.color));
                    }
                    this.branches.forEach(b => b.grow());
                }

                draw(ctx, globalAlpha = 1) {
                    if (this.points.length < 2) return;
                    ctx.save();
                    ctx.globalAlpha = 0.85 * globalAlpha;
                    ctx.strokeStyle = this.color;
                    ctx.lineWidth = this.width;
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    ctx.shadowColor = this.color;
                    ctx.shadowBlur = 10;

                    ctx.beginPath();
                    ctx.moveTo(this.points[0].x, this.points[0].y);
                    for (let i = 1; i < this.points.length; i++) {
                        ctx.lineTo(this.points[i].x, this.points[i].y);
                    }
                    ctx.stroke();
                    ctx.restore();

                    this.branches.forEach(b => b.draw(ctx, globalAlpha));
                }
            }

            /* ─── FULL WATERCOLOR FLUID TRANSITION ─── */
            function triggerWatercolorFluidTransition(newTheme, ox, oy, onMidpoint) {
                const maxR = Math.hypot(Math.max(ox, width - ox), Math.max(oy, height - oy)) * 1.15;
                const isDark = newTheme === 'dark';

                // Watercolor palette for dark & light symbiotic mode
                const palette = isDark
                    ? ['#090d14', '#0d131f', '#131d2e', '#192841', '#00f0ff', '#58a6ff', '#0d1117']
                    : ['#e8e2d2', '#f2edde', '#ede5cf', '#d5cbaf', '#ffd166', '#ffb703', '#f4f1ea'];

                const fluidDrops = [];
                const veins = [];
                const totalDrops = 32;

                // Seed concentric organic bleeding watercolor pools
                for (let i = 0; i < totalDrops; i++) {
                    const ang = Math.random() * Math.PI * 2;
                    const dist = Math.pow(Math.random(), 0.6) * (maxR * 0.85);
                    const px = ox + Math.cos(ang) * dist;
                    const py = oy + Math.sin(ang) * dist;
                    const color = palette[Math.floor(Math.random() * (palette.length - 1))];
                    const r = 90 + Math.random() * 260;
                    fluidDrops.push(new FluidDrop(px, py, color, r, 0.07 + Math.random() * 0.05, 75 + Math.random() * 40, 5));
                }

                // Core expanding tidal bleed
                fluidDrops.unshift(new FluidDrop(ox, oy, isDark ? '#0d1117' : '#f4f1ea', maxR, 0.08, 90, 8));

                // Veins radiating from origin like ink dropped in wet paper
                const veinCount = 28;
                for (let i = 0; i < veinCount; i++) {
                    const a = (i / veinCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
                    const col = isDark ? (i % 2 === 0 ? '#00f0ff' : '#0d131f') : (i % 2 === 0 ? '#b5a88c' : '#1b3b6f');
                    veins.push(new CapillaryVein(ox, oy, a, maxR * (0.6 + Math.random() * 0.45), 4 + Math.random() * 4, col));
                }

                if (toggleBtn) {
                    toggleBtn.classList.add('symbiote-active-morph');
                    setTimeout(() => toggleBtn.classList.remove('symbiote-active-morph'), 900);
                }

                let time = 0;
                let midpointFired = false;
                let masterRadius = 0;
                const masterSpeed = maxR / 28;

                function renderLoop() {
                    time += 1;
                    ctx.clearRect(0, 0, width, height);

                    masterRadius += masterSpeed;

                    // 1. Draw large fluid paper wash
                    ctx.save();
                    ctx.beginPath();
                    const segments = 48;
                    for (let i = 0; i <= segments; i++) {
                        const a = (i / segments) * Math.PI * 2;
                        const paperJitter = noise(ox + Math.cos(a) * masterRadius, oy + Math.sin(a) * masterRadius, time * 0.2);
                        const r = Math.max(0, masterRadius + paperJitter * (masterRadius * 0.22));
                        const px = ox + Math.cos(a) * r;
                        const py = oy + Math.sin(a) * r;
                        if (i === 0) ctx.moveTo(px, py);
                        else ctx.lineTo(px, py);
                    }
                    ctx.closePath();
                    ctx.fillStyle = isDark ? '#0d1117' : '#f4f1ea';
                    ctx.shadowColor = isDark ? '#00f0ff' : '#ffd166';
                    ctx.shadowBlur = 40;
                    ctx.fill();
                    ctx.restore();

                    // 2. Render and grow fluid watercolor drops
                    fluidDrops.forEach(drop => {
                        drop.update(time);
                        drop.draw(ctx, time, 0.85);
                    });

                    // 3. Render organic capillary ink tendrils
                    veins.forEach(v => {
                        v.grow();
                        v.draw(ctx, 0.9);
                    });

                    // Trigger the theme change when screen is 50% saturated with fluid
                    if (masterRadius >= maxR * 0.52 && !midpointFired) {
                        midpointFired = true;
                        if (typeof onMidpoint === 'function') onMidpoint();
                    }

                    if (masterRadius < maxR * 1.35) {
                        requestAnimationFrame(renderLoop);
                    } else {
                        // Smooth watercolor absorption into paper grain
                        let fade = 1.0;
                        function fadeOut() {
                            fade -= 0.055;
                            if (fade > 0) {
                                ctx.clearRect(0, 0, width, height);
                                ctx.save();
                                ctx.globalAlpha = fade;
                                ctx.fillStyle = isDark ? '#0d1117' : '#f4f1ea';
                                ctx.fillRect(0, 0, width, height);
                                ctx.restore();
                                requestAnimationFrame(fadeOut);
                            } else {
                                ctx.clearRect(0, 0, width, height);
                            }
                        }
                        fadeOut();
                    }
                }

                requestAnimationFrame(renderLoop);
            }

            // Click listener for theme toggle
            if (toggleBtn) {
                toggleBtn.addEventListener('click', (e) => {
                    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
                    const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
                    const rect = toggleBtn.getBoundingClientRect();
                    const originX = rect.left + rect.width / 2;
                    const originY = rect.top + rect.height / 2;
                    applyTheme(nextTheme, true, originX, originY);
                });
            }

            // Interactive Symbiotic Ripple Effect on all Action Buttons
            function attachSymbioticActionRipples() {
                const actionButtons = document.querySelectorAll('.stamp-btn, .btn-primary, .action-btn');
                actionButtons.forEach(btn => {
                    btn.addEventListener('click', function (e) {
                        const rect = btn.getBoundingClientRect();
                        const x = e.clientX ? (e.clientX - rect.left) : (rect.width / 2);
                        const y = e.clientY ? (e.clientY - rect.top) : (rect.height / 2);

                        // Remove existing ripples
                        const oldRipples = btn.querySelectorAll('.symbiotic-liquid-ripple');
                        oldRipples.forEach(r => r.remove());

                        // Spawn watercolor ink splash
                        const ripple = document.createElement('span');
                        ripple.className = 'symbiotic-liquid-ripple';
                        ripple.style.left = `${x}px`;
                        ripple.style.top = `${y}px`;
                        btn.appendChild(ripple);

                        btn.classList.add('symbiote-squish');
                        setTimeout(() => btn.classList.remove('symbiote-squish'), 600);
                        setTimeout(() => ripple.remove(), 1000);
                    });
                });
            }

            attachSymbioticActionRipples();
            applyTheme(savedTheme, false);
        }
    };

    global.SymbioticWatercolor = SymbioticWatercolor;
})(window);
