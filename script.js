// ---- Data source (loaded from terms.js) ----
const TERMS = window.TERMS_DATA || [];

// ---- Configuration ----
const PAGE_SIZE = 20; // number of items to load per infinite-scroll "page"

// ---- State ----
let activeTags = new Set();
let searchQuery = "";
let filteredTerms = [];
let renderedCount = 0;
let isLoading = false;
let observer = null;
let isTagsCollapsed = false;

// ---- Utility Functions ----
const normalize = (str) =>
  (str || "").toString().toLowerCase().normalize("NFKD");

function debounce(fn, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), wait);
  };
}

function computeUniqueTags(terms) {
  const map = new Map(); // tag -> count
  terms.forEach((t) => {
    (t.tags || []).forEach((tag) => {
      const key = tag.trim().toLowerCase();
      if (!key) return;
      map.set(key, (map.get(key) || 0) + 1);
    });
  });
  return Array.from(map.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

// ---- DOM Setup & Functions ----
function setupDOM() {
  // DOM elements
  const searchInput = document.getElementById("search-input");
  const tagContainer = document.getElementById("tag-container");
  const tagCountLabel = document.getElementById("tag-count-label");
  const clearTagsButton = document.getElementById("clear-tags-button");
  const tagsPanel = document.querySelector(".tags-panel");
  const tagsToggle = document.getElementById("tags-toggle");
  const tagsChevronButton = document.getElementById("tags-chevron-button");
  const tagsContent = document.getElementById("tags-panel-content");

  const glossaryListEl = document.getElementById("glossary-list");
  const resultsCountEl = document.getElementById("results-count");
  const appliedFiltersEl = document.getElementById("applied-filters");
  const emptyStateEl = document.getElementById("empty-state");
  const loaderEl = document.getElementById("loader");
  const sentinelEl = document.getElementById("sentinel");

  let lastScrollY = window.scrollY;

  function updateTagCountLabel() {
    const appliedCount = activeTags.size;
    if (appliedCount === 0) {
      tagCountLabel.textContent = "";
      tagCountLabel.style.display = "none";
    } else {
      tagCountLabel.style.display = "inline-flex";
      tagCountLabel.textContent =
        appliedCount === 1 ? "1 applied" : `${appliedCount} applied`;
    }
  }

  function updateClearButtonState() {
    clearTagsButton.hidden = activeTags.size === 0;
  }

  function setTagsCollapsed(collapsed) {
    isTagsCollapsed = collapsed;
    tagsPanel.classList.toggle("collapsed", collapsed);
    tagsToggle.setAttribute("aria-expanded", (!collapsed).toString());
    if (tagsChevronButton) {
      tagsChevronButton.setAttribute("aria-expanded", (!collapsed).toString());
    }
    if (collapsed) {
      tagsContent.style.maxHeight = "0px";
    } else {
      tagsContent.style.maxHeight = `${tagsContent.scrollHeight}px`;
    }
  }

  function toggleTagsCollapsed() {
    setTagsCollapsed(!isTagsCollapsed);
  }

  function syncTagsContentHeight() {
    if (!isTagsCollapsed) {
      tagsContent.style.maxHeight = `${tagsContent.scrollHeight}px`;
    }
  }

  function handleScrollCollapse() {
    const currentY = window.scrollY;
    const collapseThreshold =
      window.innerHeight || document.documentElement.clientHeight;

    // If we’re back at the very top, auto-expand if it was collapsed
    if (currentY <= 0 && isTagsCollapsed) {
      setTagsCollapsed(false);
    }
    // Auto-collapse ONLY when scrolling down past the threshold,
    // and only at the moment we cross that threshold.
    else if (
      !isTagsCollapsed &&
      currentY >= collapseThreshold &&
      lastScrollY < collapseThreshold &&
      currentY > lastScrollY
    ) {
      setTagsCollapsed(true);
    }

    lastScrollY = currentY;
  }

  function renderTagFilters() {
    const uniqueTags = computeUniqueTags(TERMS);
    tagContainer.innerHTML = "";
    uniqueTags.forEach(({ tag, count }) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tag-chip";
      chip.dataset.tag = tag;

      if (activeTags.has(tag)) {
        chip.classList.add("selected");
      }

      chip.innerHTML = `
        <span class="tag-chip-pill"></span>
        <span>${tag}</span>
        <span class="tag-chip-count">${count}</span>
      `;

      chip.addEventListener("click", () => {
        toggleTag(tag);
      });

      tagContainer.appendChild(chip);
    });

    updateTagCountLabel();
    updateClearButtonState();
    syncTagsContentHeight();
  }

  function toggleTag(tag) {
    if (activeTags.has(tag)) {
      activeTags.delete(tag);
    } else {
      activeTags.add(tag);
    }
    refreshTagUI();
    applyFiltersAndReset();
  }

  function refreshTagUI() {
    // Highlight chips
    const chips = tagContainer.querySelectorAll(".tag-chip");
    chips.forEach((chip) => {
      const tag = chip.dataset.tag;
      if (activeTags.has(tag)) {
        chip.classList.add("selected");
      } else {
        chip.classList.remove("selected");
      }
    });

    // Applied filters display
    appliedFiltersEl.innerHTML = "";
    if (activeTags.size > 0) {
      activeTags.forEach((tag) => {
        const el = document.createElement("span");
        el.className = "applied-tag";
        el.innerHTML = `
          <span class="applied-tag-dot"></span>
          <span>${tag}</span>
        `;
        appliedFiltersEl.appendChild(el);
      });
    }

    updateTagCountLabel();
    updateClearButtonState();
  }

  function clearAllTags() {
    activeTags.clear();
    refreshTagUI();
    applyFiltersAndReset();
  }

  function matchesSearch(termObj) {
    if (!searchQuery) return true;
    const q = searchQuery;
    const tName = normalize(termObj.term);
    const tagsJoined = normalize((termObj.tags || []).join(" "));
    return tName.includes(q) || tagsJoined.includes(q);
  }

  function matchesTags(termObj) {
    if (activeTags.size === 0) return true;
    const termTags = new Set((termObj.tags || []).map((t) => normalize(t)));
    for (const tag of activeTags) {
      if (!termTags.has(tag)) {
        return false; // require every selected tag
      }
    }
    return true;
  }

  function applyFilters() {
    filteredTerms = TERMS.filter((t) => matchesSearch(t) && matchesTags(t));
  }

  function resetRenderedState() {
    renderedCount = 0;
    glossaryListEl.innerHTML = "";
    emptyStateEl.style.display = "none";
    loaderEl.style.display = "none";
  }

  function updateResultsMeta() {
    const total = filteredTerms.length;
    if (total === 0) {
      resultsCountEl.textContent = "No terms found.";
    } else {
      resultsCountEl.innerHTML = `<strong>${total}</strong> term${
        total === 1 ? "" : "s"
      }`;
    }
  }

  function renderTermCard(term) {
    const card = document.createElement("article");
    card.className = "card";

    card.innerHTML = `
      <div class="card-main">
        <h2 class="card-term">${term.term}</h2>
        <p class="card-definition">${term.definition}</p>
        <div class="card-tags">
          ${
            (term.tags || [])
              .map((tag) => `<span class="card-tag">${tag}</span>`)
              .join("") ||
            `<span class="card-tag">untagged</span>`
          }
        </div>
      </div>
    `;

    return card;
  }

  function renderNextPage() {
    if (isLoading) return;
    if (renderedCount >= filteredTerms.length) return;
    isLoading = true;
    loaderEl.style.display = "block";

    const start = renderedCount;
    const end = Math.min(filteredTerms.length, start + PAGE_SIZE);
    const slice = filteredTerms.slice(start, end);

    const fragment = document.createDocumentFragment();
    slice.forEach((term) => {
      fragment.appendChild(renderTermCard(term));
    });
    glossaryListEl.appendChild(fragment);

    renderedCount = end;
    isLoading = false;
    loaderEl.style.display =
      renderedCount < filteredTerms.length ? "block" : "none";
  }

  function handleEmptyState() {
    if (filteredTerms.length === 0) {
      emptyStateEl.style.display = "block";
    } else {
      emptyStateEl.style.display = "none";
    }
  }

  function applyFiltersAndReset() {
    resetRenderedState();
    applyFilters();
    updateResultsMeta();
    handleEmptyState();
    renderNextPage();
  }

  // ---- Infinite Scroll Setup ----
  function setupObserver() {
    if (observer) {
      observer.disconnect();
    }
    observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry && entry.isIntersecting) {
          renderNextPage();
        }
      },
      {
        root: null,
        rootMargin: "120px",
        threshold: 0.01,
      }
    );
    observer.observe(sentinelEl);
  }

  // ---- Event Listeners ----
  function attachEventListeners() {
    const debouncedSearch = debounce((value) => {
      searchQuery = normalize(value.trim());
      applyFiltersAndReset();
    }, 160);

    searchInput.addEventListener("input", (e) => {
      debouncedSearch(e.target.value);
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (searchInput.value) {
          searchInput.value = "";
          searchQuery = "";
          applyFiltersAndReset();
        }
      }
    });

    clearTagsButton.addEventListener("click", () => {
      clearAllTags();
    });

    tagsToggle.addEventListener("click", () => {
      toggleTagsCollapsed();
    });

    if (tagsChevronButton) {
      tagsChevronButton.addEventListener("click", () => {
        toggleTagsCollapsed();
      });
    }

    window.addEventListener("scroll", handleScrollCollapse, { passive: true });
  }

  // ---- Initialization ----
  function init() {
    setTagsCollapsed(false);
    renderTagFilters();
    refreshTagUI();
    applyFilters();
    updateResultsMeta();
    renderNextPage();
    handleEmptyState();
    setupObserver();
    attachEventListeners();
  }

  init();
}

document.addEventListener("DOMContentLoaded", setupDOM);


