// Noumen — Book Tracker

const API_BASE = 'http://localhost:8000/api';

// State
let books          = [];
let currentBookId  = null;
let editingBookId  = null;
let currentRating  = 0;
let activeStatusTab = 'all';
let currentLayout  = 'grid-2';
let currentFilters = {
    sortBy:     'recent',
    author:     '',
    minRating:  0,
    dateFilter: 'all',
};

const STATUS_LABELS = {
    'reading':   'reading',
    'completed': 'completed',
    'to-read':   'to read',
    'on-hold':   'on hold',
    'dropped':   'dropped',
};

// DOM refs
const booksContainer  = document.getElementById('booksContainer');
const noResults       = document.getElementById('noResults');
const searchInput     = document.getElementById('searchInput');
const clearSearchBtn  = document.getElementById('clearSearch');
const loadingSkeleton = document.getElementById('loadingSkeleton');

const bookModal    = document.getElementById('bookModal');
const detailsModal = document.getElementById('detailsModal');
const statsSheet   = document.getElementById('statsSheet');
const filterSheet  = document.getElementById('filterSheet');
const toast        = document.getElementById('toast');

const bookForm         = document.getElementById('bookForm');
const modalTitle       = document.getElementById('modalTitle');
const bookTitleInput   = document.getElementById('bookTitle');
const bookAuthorInput  = document.getElementById('bookAuthor');
const bookStatusSelect = document.getElementById('bookStatus');
const currentChapterInput = document.getElementById('currentChapter');
const totalChaptersInput  = document.getElementById('totalChapters');
const bookRatingInput  = document.getElementById('bookRating');
const bookCategoryInput = document.getElementById('bookCategory');
const bookNotesInput   = document.getElementById('bookNotes');
const coverImageInput  = document.getElementById('coverImage');
const coverUpload      = document.getElementById('coverUpload');
const coverPreview     = document.getElementById('coverPreview');
const filterAuthorInput = document.getElementById('filterAuthor');

let currentCoverData  = null;
let currentBookForEdit = null;

// Init
async function initApp() {
    setupEventListeners();
    setupViewToggle();
    setupNavigation();
    try {
        await loadBooks();
    } catch (error) {
        console.error('Failed to connect to server:', error);
        showToast('Server unavailable — loading sample data', 'warning');
        loadSampleData();
    }
}

function toggleProfile(show) {
    const screen = document.getElementById('profileScreen');
    if (screen) screen.hidden = !show;
}

// Navigation handler
function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item, .nav-center');
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const nav = item.dataset.nav;
            
            navItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            toggleProfile(nav === 'profile');
            
            switch(nav) {
                case 'home':
                    activeStatusTab = 'all';
                    document.querySelectorAll('.status-tab').forEach(tab => {
                        if(tab.dataset.status === 'all') tab.classList.add('active');
                        else tab.classList.remove('active');
                    });
                    searchInput.value = '';
                    clearSearchBtn.style.display = 'none';
                    applyCurrentFilters();
                    break;
                case 'discover':
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                    break;
                case 'create':
                    openAddBookModal();
                    break;
                case 'stats':
                    openStatsSheet();
                    break;
                case 'profile':
                    break;
            }
        });
    });
}

// Grid/Layout Setup
function setupViewToggle() {
    const viewBtns = document.querySelectorAll('.view-btn');
    viewBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            viewBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentLayout = btn.dataset.view;
            booksContainer.className = `books-container ${currentLayout}`;
            applyCurrentFilters();
        });
    });
}

// Event wiring
function setupEventListeners() {
    searchInput.addEventListener('input', handleSearch);
    clearSearchBtn.addEventListener('click', clearSearch);

    coverUpload.addEventListener('click', () => coverImageInput.click());
    coverImageInput.addEventListener('change', handleCoverUpload);
    bookForm.addEventListener('submit', handleBookSubmit);

    setupStarRating();
    setupFilterRating();
    setupStatusTabs();

    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', e => {
            if (e.target === modal) closeAllModals();
        });
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeAllModals();
    });
}

// Status tabs
function setupStatusTabs() {
    document.querySelectorAll('.status-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.status-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeStatusTab = tab.dataset.status;
            searchInput.value = '';
            clearSearchBtn.style.display = 'none';
            applyCurrentFilters();
        });
    });
}

// Star rating (Add/Edit form)
function setupStarRating() {
    const stars = document.querySelectorAll('#starRating span');
    stars.forEach(star => {
        star.addEventListener('click', () => {
            setRating(parseInt(star.dataset.value));
        });
        star.addEventListener('mouseover', () => {
            highlightStars('starRating', parseInt(star.dataset.value));
        });
    });
    document.getElementById('starRating').addEventListener('mouseleave', () => {
        highlightStars('starRating', currentRating);
    });
}

function setRating(rating) {
    currentRating = rating;
    bookRatingInput.value = rating;
    document.getElementById('ratingValue').textContent = rating;
    highlightStars('starRating', rating);
}

// Star rating (Filter sheet)
function setupFilterRating() {
    document.querySelectorAll('#starFilter span').forEach(star => {
        star.addEventListener('click', () => {
            const val = parseInt(star.dataset.value);
            currentFilters.minRating = val;
            highlightStars('starFilter', val);
            document.getElementById('minRating').textContent = val;
        });
    });
}

function highlightStars(containerId, rating) {
    document.querySelectorAll(`#${containerId} span`).forEach((star, idx) => {
        const icon = star.querySelector('i');
        if (idx + 1 <= rating) {
            icon.className = 'fas fa-star';
            star.classList.add('active');
        } else {
            icon.className = 'far fa-star';
            star.classList.remove('active');
        }
    });
}

// API helpers
async function loadBooks() {
    showLoading();
    try {
        const res = await fetch(`${API_BASE}/books`);
        if (res.status === 401) { location.href = 'login.html'; return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        books = await res.json();
    } finally {
        hideLoading();
    }
    applyCurrentFilters();
}

async function saveBook(bookData, isUpdate, bookId) {
    const url    = isUpdate ? `${API_BASE}/book/${bookId}` : `${API_BASE}/books`;
    const method = isUpdate ? 'PUT' : 'POST';

    const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bookData),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || err.message || 'Failed to save book');
    }
    return res.json();
}

async function deleteBook(bookId) {
    const res = await fetch(`${API_BASE}/book/${bookId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete book');
    return res.json();
}

async function getStats() {
    const res = await fetch(`${API_BASE}/stats`);
    if (!res.ok) throw new Error('Failed to fetch stats');
    return res.json();
}

function showLoading() {
    loadingSkeleton.style.display = 'block';
    noResults.style.display = 'none';
    Array.from(booksContainer.children).forEach(child => {
        if (child.id !== 'loadingSkeleton') child.remove();
    });
}

function hideLoading() {
    loadingSkeleton.style.display = 'none';
}

// Rendering
function generateBookItems(bookList) {
    Array.from(booksContainer.children).forEach(child => {
        if (child.id !== 'loadingSkeleton') child.remove();
    });

    if (bookList.length === 0) {
        noResults.style.display = 'block';
        return;
    }
    noResults.style.display = 'none';

    const statusTexts = {
        'reading':   'Reading',
        'completed': 'Completed',
        'to-read':   'To Read',
        'on-hold':   'On Hold',
        'dropped':   'Dropped',
    };

    bookList.forEach(book => {
        const item = document.createElement('div');
        item.className = 'book-card';
        item.dataset.id = book.id;

        const words    = book.title.split(' ');
        const initials = (words[0][0] + (words[1] ? words[1][0] : '')).toUpperCase();
        const rating   = book.rating || 0;

        const cur   = book.current_chapter || 0;
        const total = book.total_chapters  || 0;
        
        let progressHtml = '';
        if (cur > 0 && total > 0) {
            const pct = Math.min(100, Math.round((cur / total) * 100));
            progressHtml = `
                <div class="book-progress-bar">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width:${pct}%"></div>
                    </div>
                    <span class="progress-label">${pct}%</span>
                </div>`;
        }

        if (currentLayout === 'list') {
            item.innerHTML = `
                <div class="book-cover">
                    ${book.coverUrl
                        ? `<img src="${book.coverUrl}" alt="${escHtml(book.title)}">`
                        : `<div class="initials">${initials}</div>`}
                </div>
                <div class="book-info">
                    <div class="book-title">${escHtml(book.title)}</div>
                    <div class="book-author">${escHtml(book.author)}</div>
                    <div class="book-meta">
                        <span class="book-status status-${book.status}">${statusTexts[book.status] || book.status}</span>
                        ${rating > 0 ? `<span class="book-rating"><i class="fas fa-star"></i>${rating}</span>` : ''}
                    </div>
                    ${progressHtml}
                </div>
                <i class="fas fa-chevron-right arrow-icon"></i>`;
        } else {
            item.innerHTML = `
                <div class="book-cover">
                    ${book.coverUrl
                        ? `<img src="${book.coverUrl}" alt="${escHtml(book.title)}">`
                        : `<div class="initials">${initials}</div>`}
                </div>
                <div class="book-info">
                    <div class="book-title">${escHtml(book.title)}</div>
                    <div class="book-author">${escHtml(book.author)}</div>
                    <div class="book-meta">
                        <span class="book-status status-${book.status}">${statusTexts[book.status] || book.status}</span>
                        ${rating > 0 ? `<span class="book-rating"><i class="fas fa-star"></i>${rating}</span>` : ''}
                    </div>
                    ${progressHtml}
                </div>`;
        }

        item.addEventListener('click', () => openBookDetails(book.id));
        booksContainer.appendChild(item);
    });

    const bookCountSpan = document.getElementById('bookCount');
    if (bookCountSpan) bookCountSpan.textContent = `${bookList.length} book${bookList.length !== 1 ? 's' : ''}`;
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Filtering / sorting
function applyCurrentFilters() {
    let list = [...books];

    if (activeStatusTab !== 'all') {
        list = list.filter(b => b.status === activeStatusTab);
    }

    if (currentFilters.author) {
        const q = currentFilters.author.toLowerCase();
        list = list.filter(b => b.author.toLowerCase().includes(q));
    }

    if (currentFilters.minRating > 0) {
        list = list.filter(b => (b.rating || 0) >= currentFilters.minRating);
    }

    if (currentFilters.dateFilter !== 'all') {
        const cutoff = new Date();
        switch (currentFilters.dateFilter) {
            case '3days':  cutoff.setDate(cutoff.getDate() - 3);     break;
            case '7days':  cutoff.setDate(cutoff.getDate() - 7);     break;
            case '1month': cutoff.setMonth(cutoff.getMonth() - 1);   break;
        }
        list = list.filter(b => new Date(b.created_at * 1000) >= cutoff);
    }

    switch (currentFilters.sortBy) {
        case 'title':  list.sort((a, b) => a.title.localeCompare(b.title));   break;
        case 'author': list.sort((a, b) => a.author.localeCompare(b.author)); break;
        default:       list.sort((a, b) => b.created_at - a.created_at);      break;
    }

    generateBookItems(list);
}

// Search
function handleSearch() {
    const term = searchInput.value.toLowerCase().trim();
    clearSearchBtn.style.display = term ? 'block' : 'none';

    if (!term) {
        applyCurrentFilters();
        return;
    }

    let base = activeStatusTab === 'all' ? [...books]
             : books.filter(b => b.status === activeStatusTab);

    const filtered = base.filter(b =>
        b.title.toLowerCase().includes(term) ||
        b.author.toLowerCase().includes(term) ||
        (b.category && b.category.toLowerCase().includes(term)) ||
        (STATUS_LABELS[b.status] || '').includes(term)
    );

    generateBookItems(filtered);
}

function clearSearch() {
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    applyCurrentFilters();
    searchInput.focus();
}

// Add / Edit modal
function openAddBookModal() {
    editingBookId  = null;
    currentCoverData = null;
    currentRating  = 0;
    modalTitle.textContent = 'Add New Book';
    bookForm.reset();
    coverPreview.innerHTML = '';
    setRating(0);
    bookModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    bookTitleInput.focus();
}

function openEditBookModal(bookId) {
    const book = books.find(b => b.id === bookId);
    if (!book) return;

    editingBookId  = bookId;
    currentCoverData = null;
    currentRating  = book.rating || 0;
    modalTitle.textContent = 'Edit Book';

    bookTitleInput.value     = book.title    || '';
    bookAuthorInput.value    = book.author   || '';
    bookStatusSelect.value   = book.status   || 'to-read';
    currentChapterInput.value = book.current_chapter || '';
    totalChaptersInput.value  = book.total_chapters  || '';
    bookCategoryInput.value  = book.category || '';
    bookNotesInput.value     = book.notes    || '';
    setRating(book.rating || 0);

    coverPreview.innerHTML = book.coverUrl
        ? `<img src="${book.coverUrl}" alt="${escHtml(book.title)}">`
        : '';

    bookModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    bookTitleInput.focus();
}

function closeBookModal() {
    bookModal.style.display = 'none';
    document.body.style.overflow = '';
    currentCoverData = null;
}

// Book form submission
async function handleBookSubmit(e) {
    e.preventDefault();

    const title          = bookTitleInput.value.trim();
    const author         = bookAuthorInput.value.trim();
    const status         = bookStatusSelect.value;
    const currentChapter = parseInt(currentChapterInput.value) || 0;
    const totalChapters  = parseInt(totalChaptersInput.value)  || 0;
    const rating         = parseInt(bookRatingInput.value)     || 0;
    const category       = bookCategoryInput.value.trim();
    const notes          = bookNotesInput.value.trim();

    if (!title || !author) {
        showToast('Title and author are required', 'error'); return;
    }
    if (totalChapters > 0 && currentChapter > totalChapters) {
        showToast('Current chapter cannot exceed total chapters', 'error'); return;
    }

    const bookData = {
        title, author, status, currentChapter, totalChapters, rating, category, notes,
    };
    if (currentCoverData) bookData.coverData = currentCoverData;

    const saveBtn = document.getElementById('saveBookBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
        const isUpdate = !!editingBookId;
        await saveBook(bookData, isUpdate, editingBookId);
        showToast(isUpdate ? 'Book updated!' : 'Book added!', 'success');
        await loadBooks();
        closeBookModal();
    } catch (err) {
        showToast(err.message || 'Failed to save book', 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Book';
    }
}

// Cover upload
function handleCoverUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showToast('Please select an image file', 'error'); return;
    }
    if (file.size > 2 * 1024 * 1024) {
        showToast('Image must be under 2 MB', 'error'); return;
    }

    const reader = new FileReader();
    reader.onload  = ev => {
        currentCoverData = ev.target.result;
        coverPreview.innerHTML = `<img src="${currentCoverData}" alt="Cover preview">`;
    };
    reader.onerror = () => showToast('Failed to read image', 'error');
    reader.readAsDataURL(file);
}

// Details modal
function openBookDetails(bookId) {
    const book = books.find(b => b.id === bookId);
    if (!book) return;

    currentBookId    = bookId;
    currentBookForEdit = book;

    const statusTexts = {
        'reading':   'Currently Reading',
        'completed': 'Completed',
        'to-read':   'Plan to Read',
        'on-hold':   'On Hold',
        'dropped':   'Dropped',
    };

    const words    = book.title.split(' ');
    const initials = (words[0][0] + (words[1] ? words[1][0] : '')).toUpperCase();
    const rating   = book.rating || 0;

    const formatDate = ts => {
        if (!ts) return 'Unknown';
        const d    = new Date(ts * 1000);
        const days = Math.ceil((Date.now() - d) / 86400000);
        if (days <= 1)  return 'Today';
        if (days < 7)   return `${days} days ago`;
        if (days < 30)  return `${Math.floor(days / 7)} weeks ago`;
        return d.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
    };

    let starsHtml = '';
    for (let i = 1; i <= 5; i++) {
        starsHtml += `<i class="${i <= rating ? 'fas' : 'far'} fa-star"></i>`;
    }

    const cur   = book.current_chapter || 0;
    const total = book.total_chapters  || 0;
    let progressHtml = '';
    if (cur > 0 && total > 0) {
        const pct = Math.min(100, Math.round((cur / total) * 100));
        progressHtml = `
            <div class="detail-item" style="grid-column:span 2;">
                <div class="detail-label">Progress</div>
                <div class="book-progress-bar" style="margin-top:6px;">
                    <div class="progress-bar" style="max-width:none;flex:1;">
                        <div class="progress-fill" style="width:${pct}%"></div>
                    </div>
                    <span class="progress-label">${pct}%</span>
                </div>
            </div>`;
    }

    document.getElementById('bookDetailsContent').innerHTML = `
        <div class="details-cover">
            ${book.coverUrl
                ? `<img src="${book.coverUrl}" alt="${escHtml(book.title)}">`
                : `<div style="width:100%;height:100%;background:linear-gradient(135deg,#667eea,#764ba2);
                              display:flex;align-items:center;justify-content:center;
                              color:white;font-size:30px;font-weight:bold;">${initials}</div>`}
        </div>
        <h3 class="details-title">${escHtml(book.title)}</h3>
        <p class="details-author">by ${escHtml(book.author)}</p>

        ${rating > 0 ? `
            <div class="rating-display">
                <div class="stars">${starsHtml}</div>
                <div class="rating-value">${rating} / 5</div>
            </div>` : ''}

        <div class="details-grid">
            <div class="detail-item">
                <div class="detail-label">Status</div>
                <div class="detail-value">${statusTexts[book.status] || book.status}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Chapter</div>
                <div class="detail-value">${cur > 0 ? `${cur}${total > 0 ? ' / ' + total : ''}` : 'Not started'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Category</div>
                <div class="detail-value">${escHtml(book.category) || '—'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Added</div>
                <div class="detail-value">${formatDate(book.created_at)}</div>
            </div>
            ${progressHtml}
        </div>

        ${book.notes ? `
            <div class="detail-item">
                <div class="detail-label">Notes</div>
                <div class="detail-value" style="font-weight:400;white-space:pre-wrap;margin-top:6px;">
                    ${escHtml(book.notes)}</div>
            </div>` : ''}
    `;

    resetDetailsActions();
    detailsModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function resetDetailsActions() {
    document.getElementById('detailsActions').innerHTML = `
        <button class="btn-edit" onclick="editCurrentBook()">
            <i class="fas fa-edit"></i> Edit
        </button>
        <button class="btn-delete" onclick="initiateDelete()">
            <i class="fas fa-trash"></i> Delete
        </button>`;
}

function closeDetailsModal() {
    detailsModal.style.display = 'none';
    document.body.style.overflow = '';
    currentBookId = null;
    currentBookForEdit = null;
}

function editCurrentBook() {
    const id = currentBookId || (currentBookForEdit && currentBookForEdit.id);
    if (!id) return;
    closeDetailsModal();
    setTimeout(() => openEditBookModal(id), 40);
}

function initiateDelete() {
    document.getElementById('detailsActions').innerHTML = `
        <span class="delete-confirm-msg">Delete this book?</span>
        <button class="btn-cancel-delete" onclick="resetDetailsActions()">Cancel</button>
        <button class="btn-delete-confirm" onclick="confirmDeleteBook()">Delete</button>`;
}

async function confirmDeleteBook() {
    const id = currentBookId || (currentBookForEdit && currentBookForEdit.id);
    if (!id) return;
    try {
        await deleteBook(id);
        await loadBooks();
        closeDetailsModal();
        showToast('Book deleted', 'success');
    } catch {
        showToast('Failed to delete book', 'error');
    }
}

// Stats sheet
async function openStatsSheet() {
    try {
        const stats    = await getStats();
        const byStatus = stats.byStatus || {};

        document.getElementById('statsGrid').innerHTML = `
            <div class="stat-card">
                <div class="stat-value">${stats.totalBooks}</div>
                <div class="stat-label">Total Books</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${byStatus.reading || 0}</div>
                <div class="stat-label">Reading</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${byStatus.completed || 0}</div>
                <div class="stat-label">Completed</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.totalPages || 0}</div>
                <div class="stat-label">Total Chapters</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${byStatus['to-read'] || 0}</div>
                <div class="stat-label">To Read</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.avgProgress}%</div>
                <div class="stat-label">Avg Progress</div>
            </div>`;

        statsSheet.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    } catch {
        showToast('Failed to load stats', 'error');
    }
}

function closeStatsSheet() {
    statsSheet.style.display = 'none';
    document.body.style.overflow = '';
}

// Filter sheet
function openFilterSheet() {
    filterAuthorInput.value = currentFilters.author;
    highlightStars('starFilter', currentFilters.minRating);
    document.getElementById('minRating').textContent = currentFilters.minRating;

    const sortRadio = document.querySelector(`input[name="sortBy"][value="${currentFilters.sortBy}"]`);
    if (sortRadio) sortRadio.checked = true;

    const dateRadio = document.querySelector(`input[name="dateFilter"][value="${currentFilters.dateFilter}"]`);
    if (dateRadio) dateRadio.checked = true;

    filterSheet.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeFilterSheet() {
    filterSheet.style.display = 'none';
    document.body.style.overflow = '';
}

function applyFilters() {
    const sortRadio = document.querySelector('input[name="sortBy"]:checked');
    const dateRadio = document.querySelector('input[name="dateFilter"]:checked');

    currentFilters.sortBy     = sortRadio ? sortRadio.value : 'recent';
    currentFilters.author     = filterAuthorInput.value.trim();
    currentFilters.dateFilter = dateRadio ? dateRadio.value : 'all';

    applyCurrentFilters();
    closeFilterSheet();
    showToast('Filters applied', 'success');
}

function clearFilters() {
    currentFilters = { sortBy: 'recent', author: '', minRating: 0, dateFilter: 'all' };
    filterAuthorInput.value = '';
    highlightStars('starFilter', 0);
    document.getElementById('minRating').textContent = '0';
    const r = document.querySelector('input[name="sortBy"][value="recent"]');
    if (r) r.checked = true;
    const a = document.querySelector('input[name="dateFilter"][value="all"]');
    if (a) a.checked = true;
    applyCurrentFilters();
    showToast('Filters cleared', 'success');
}

function closeAllModals() {
    [bookModal, detailsModal, statsSheet, filterSheet].forEach(m => {
        m.style.display = 'none';
    });
    document.body.style.overflow = '';
    currentBookId = null;
    editingBookId = null;
    currentCoverData = null;
    currentBookForEdit = null;
}

// Toast
let toastTimer = null;
function showToast(message, type = 'success', duration = 3000) {
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// Sample data
function loadSampleData() {
    books = [
        {
            id: 'sample_1', title: 'The Great Gatsby', author: 'F. Scott Fitzgerald',
            status: 'completed', current_chapter: 9, total_chapters: 9,
            rating: 5, category: 'Classic', notes: 'A classic novel about the American Dream.',
            coverUrl: '', created_at: Math.floor(Date.now() / 1000) - 86400 * 30,
            updated_at: Math.floor(Date.now() / 1000) - 86400 * 15,
        },
        {
            id: 'sample_2', title: 'To Kill a Mockingbird', author: 'Harper Lee',
            status: 'reading', current_chapter: 15, total_chapters: 31,
            rating: 4, category: 'Classic', notes: 'Currently reading for book club.',
            coverUrl: '', created_at: Math.floor(Date.now() / 1000) - 86400 * 7,
            updated_at: Math.floor(Date.now() / 1000),
        },
        {
            id: 'sample_3', title: 'Dune', author: 'Frank Herbert',
            status: 'to-read', current_chapter: 0, total_chapters: 0,
            rating: 0, category: 'Sci-Fi', notes: '',
            coverUrl: '', created_at: Math.floor(Date.now() / 1000) - 86400 * 2,
            updated_at: Math.floor(Date.now() / 1000),
        },
    ];
    hideLoading();
    applyCurrentFilters();
}

// Boot
function initThemeToggle() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('noumen-theme', next); } catch (e) {}
    });
}

async function loadAvatar() {
    const img = document.getElementById('navAvatarImg');
    const btn = document.querySelector('.nav-avatar');
    if (!img || !btn) return;
    try {
        const res = await fetch(`${API_BASE}/me`);
        if (!res.ok) return;
        const me = await res.json();
        if (!me.avatar) return;
        const big = document.getElementById('profileAvatarImg');
        const pa  = document.querySelector('.profile-avatar');
        img.onerror = () => { img.hidden = true; btn.classList.remove('has-avatar'); };
        img.onload  = () => { img.hidden = false; btn.classList.add('has-avatar'); };
        img.src = me.avatar;
        if (big && pa) {
            big.onerror = () => { big.hidden = true; pa.classList.remove('has-avatar'); };
            big.onload  = () => { big.hidden = false; pa.classList.add('has-avatar'); };
            big.src = me.avatar;
        }
    } catch (e) {}
}

function initLogout() {
    const btn = document.getElementById('logoutBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        try { await fetch(`${API_BASE}/logout`, { method: 'POST' }); } catch (e) {}
        location.href = 'login.html';
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initThemeToggle();
    initLogout();
    loadAvatar();
    initApp();
});