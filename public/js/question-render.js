/* Question rendering helpers shared by the admin preview and the exam player:
   KaTeX maths, highlight.js code, ordering and essay word-count components. */
(function () {
  'use strict';

  function enhance(root) {
    if (window.renderMathInElement) {
      root.querySelectorAll('.q-content').forEach(function (el) {
        try {
          window.renderMathInElement(el, {
            delimiters: [
              { left: '\\[', right: '\\]', display: true },
              { left: '$$', right: '$$', display: true },
              { left: '\\(', right: '\\)', display: false },
            ],
            throwOnError: false,
          });
        } catch (e) {
          /* keep raw LaTeX */
        }
      });
    }
    if (window.hljs) {
      root.querySelectorAll('.q-content pre code').forEach(function (el) {
        if (!el.dataset.highlighted) window.hljs.highlightElement(el);
      });
    }
  }
  window.QuestionRender = { enhance: enhance };

  document.addEventListener('alpine:init', function () {
    var Alpine = window.Alpine;

    /* Ordering: server renders the items; this moves the real <li> nodes (no x-html in the CSP build). */
    Alpine.data('orderInput', function () {
      return {
        dragged: null,
        lis: function () {
          return Array.prototype.slice.call(this.$root.querySelectorAll('[data-order-item]'));
        },
        renumber: function () {
          var list = this.lis();
          list.forEach(function (li, i) {
            li.querySelector('[data-order-pos]').textContent = String(i + 1);
            var up = li.querySelector('[data-dir="up"]');
            var down = li.querySelector('[data-dir="down"]');
            if (up && !up.hasAttribute('data-locked')) up.disabled = i === 0;
            if (down && !down.hasAttribute('data-locked')) down.disabled = i === list.length - 1;
          });
          this.$dispatch('answer-changed');
        },
        init: function () {
          var self = this;
          if (this.$root.querySelector('button[disabled]') && this.$root.querySelectorAll('button[disabled]').length === this.$root.querySelectorAll('button').length) {
            this.$root.querySelectorAll('button').forEach(function (b) {
              b.setAttribute('data-locked', '1');
            });
          }
          this.$nextTick(function () {
            self.renumber();
          });
        },
        up: function (e) {
          var li = e.currentTarget.closest('[data-order-item]');
          if (li.previousElementSibling) li.parentNode.insertBefore(li, li.previousElementSibling);
          this.renumber();
          e.currentTarget.focus();
        },
        down: function (e) {
          var li = e.currentTarget.closest('[data-order-item]');
          if (li.nextElementSibling) li.parentNode.insertBefore(li.nextElementSibling, li);
          this.renumber();
          e.currentTarget.focus();
        },
        drag: function (e) {
          this.dragged = e.currentTarget;
        },
        drop: function (e) {
          var target = e.currentTarget;
          if (!this.dragged || this.dragged === target) return;
          var list = this.lis();
          if (list.indexOf(this.dragged) < list.indexOf(target)) target.parentNode.insertBefore(this.dragged, target.nextSibling);
          else target.parentNode.insertBefore(this.dragged, target);
          this.dragged = null;
          this.renumber();
        },
      };
    });

    Alpine.data('wordCount', function () {
      return {
        words: 0,
        init: function () {
          this.count();
        },
        count: function () {
          var t = (this.$refs.area && this.$refs.area.value) || '';
          this.words = t.trim() ? t.trim().split(/\s+/).length : 0;
        },
      };
    });
  });

  document.addEventListener('DOMContentLoaded', function () {
    enhance(document);
  });
})();
