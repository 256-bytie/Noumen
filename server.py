#!/data/data/com.termux/files/usr/bin/python3
"""
Book Tracker Server for Termux — SQLite backend with image support
"""

import os
import json
import sqlite3
import base64
import mimetypes
import time
import uuid
import sys
import re
import hmac
import hashlib
import secrets
from http.cookies import SimpleCookie
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
import traceback

PORT = 8000
DB_FILE = 'books.db'
COVERS_DIR = 'covers'
STATIC_FILES = ['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.ico', '.webp']

SESSION_TTL    = 60 * 60 * 24 * 30   # 30 days
PBKDF2_ROUNDS  = 200_000
PUBLIC_PATHS   = {'/login.html', '/style.css', '/logo/logo1.png', '/logo/logo1-dark.png'}
EMAIL_RE       = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')

VALID_STATUSES = {'reading', 'completed', 'to-read', 'on-hold', 'dropped'}
MAX_TEXT_LEN  = 255
MAX_NOTES_LEN = 2000

os.makedirs(COVERS_DIR, exist_ok=True)


# ── Database ──────────────────────────────────────────────────────────────────

def init_database():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS books (
            id              TEXT PRIMARY KEY,
            title           TEXT NOT NULL,
            author          TEXT NOT NULL,
            status          TEXT DEFAULT 'to-read',
            current_chapter INTEGER DEFAULT 0,
            total_chapters  INTEGER DEFAULT 0,
            rating          INTEGER DEFAULT 0,
            category        TEXT DEFAULT '',
            notes           TEXT DEFAULT '',
            cover_filename  TEXT DEFAULT '',
            created_at      INTEGER,
            updated_at      INTEGER
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id            TEXT PRIMARY KEY,
            email         TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            salt          TEXT NOT NULL,
            created_at    INTEGER
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL,
            created_at INTEGER
        )
    ''')
    cols = [r[1] for r in cursor.execute('PRAGMA table_info(users)').fetchall()]
    if 'avatar' not in cols:
        cursor.execute("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''")
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_status ON books(status)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_author ON books(author)')
    conn.commit()
    conn.close()
    print(f"Database ready: {DB_FILE}")


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_cover_ext(data_uri):
    """Detect correct file extension from a base64 data URI."""
    if data_uri.startswith('data:'):
        mime = data_uri.split(';')[0].split(':')[1]
        ext = mimetypes.guess_extension(mime)
        if ext:
            return '.jpg' if ext == '.jpeg' else ext
    return '.jpg'


def validate_book(data):
    """Validate and sanitize incoming book data.

    Returns (clean_dict, error_string). If error_string is not None, clean_dict is None.
    """
    title  = str(data.get('title',  '')).strip()
    author = str(data.get('author', '')).strip()

    if not title:
        return None, "Title is required"
    if not author:
        return None, "Author is required"
    if len(title) > MAX_TEXT_LEN:
        return None, f"Title must be under {MAX_TEXT_LEN} characters"
    if len(author) > MAX_TEXT_LEN:
        return None, f"Author must be under {MAX_TEXT_LEN} characters"

    status = str(data.get('status', 'to-read'))
    if status not in VALID_STATUSES:
        status = 'to-read'

    try:
        current_chapter = max(0, int(data.get('currentChapter', 0)))
    except (ValueError, TypeError):
        current_chapter = 0

    try:
        total_chapters = max(0, int(data.get('totalChapters', 0)))
    except (ValueError, TypeError):
        total_chapters = 0

    try:
        rating = max(0, min(5, int(data.get('rating', 0))))
    except (ValueError, TypeError):
        rating = 0

    category = str(data.get('category', '')).strip()[:MAX_TEXT_LEN]
    notes    = str(data.get('notes',    '')).strip()[:MAX_NOTES_LEN]

    return {
        'title': title, 'author': author, 'status': status,
        'currentChapter': current_chapter, 'totalChapters': total_chapters,
        'rating': rating, 'category': category, 'notes': notes,
    }, None


def save_cover(data_uri, book_id, old_filename=None):
    """Decode and persist a cover image. Returns new filename or empty string on failure."""
    try:
        ext = get_cover_ext(data_uri)
        filename  = f"{book_id}{ext}"
        cover_path = os.path.join(COVERS_DIR, filename)
        raw_b64 = data_uri.split(',')[1] if ',' in data_uri else data_uri
        with open(cover_path, 'wb') as f:
            f.write(base64.b64decode(raw_b64))
        # Remove old cover if it has a different name (e.g., different extension)
        if old_filename and old_filename != filename:
            old_path = os.path.join(COVERS_DIR, old_filename)
            if os.path.exists(old_path):
                os.remove(old_path)
        return filename
    except Exception as e:
        print(f"Cover save failed: {e}", file=sys.stderr)
        return ''


# ── Auth helpers ──────────────────────────────────────────────────────────────

def hash_password(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, PBKDF2_ROUNDS).hex()


def hash_token(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def validate_credentials(data):
    email    = str(data.get('email', '')).strip().lower()
    password = str(data.get('password', ''))
    if len(email) > 254 or not EMAIL_RE.match(email):
        return None, None, 'Enter a valid email'
    if len(password) < 8:
        return None, None, 'Password must be at least 8 characters'
    if len(password) > 128:
        return None, None, 'Password is too long'
    return email, password, None


# ── Request handler ───────────────────────────────────────────────────────────

class BookTrackerHandler(BaseHTTPRequestHandler):

    # ── CORS ──────────────────────────────────────────────────────────────────

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    # ── Routing ───────────────────────────────────────────────────────────────

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path not in PUBLIC_PATHS:
                user = self.require_auth(path)
                if not user:
                    return
            if path == '/api/me':
                self.send_json(200, {'email': user['email'], 'avatar': user['avatar']})
            elif path == '/api/books':
                self.handle_get_books()
            elif path.startswith('/api/book/'):
                book_id = path[len('/api/book/'):]
                if not book_id:
                    self.send_error(400, "Missing book ID"); return
                self.handle_get_book(book_id)
            elif path.startswith('/covers/'):
                self.handle_get_cover(path)
            elif path == '/api/stats':
                self.handle_get_stats()
            elif any(path.endswith(ext) for ext in STATIC_FILES):
                self.handle_static_file(path)
            else:
                self.handle_static_file('/index.html')
        except Exception as e:
            self.send_error(500, str(e))
            print(f"GET {path} → 500: {e}", file=sys.stderr)
            traceback.print_exc()

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            length = int(self.headers.get('Content-Length', 0))
            body   = self.rfile.read(length)
            if path == '/api/signup':
                self.handle_signup(body)
            elif path == '/api/login':
                self.handle_login(body)
            elif path == '/api/logout':
                self.handle_logout()
            elif path == '/api/books':
                if not self.require_auth(path):
                    return
                self.handle_post_book(body)
            else:
                self.send_error(404, "Not found")
        except Exception as e:
            self.send_error(500, str(e))
            print(f"POST {path} → 500: {e}", file=sys.stderr)

    def do_PUT(self):
        path = urlparse(self.path).path
        if not self.require_auth(path):
            return
        if path.startswith('/api/book/'):
            book_id = path[len('/api/book/'):]
            if not book_id:
                self.send_error(400, "Missing book ID"); return
            try:
                length = int(self.headers.get('Content-Length', 0))
                body   = self.rfile.read(length)
                self.handle_update_book(book_id, body)
            except Exception as e:
                self.send_error(500, str(e))
                print(f"PUT {path} → 500: {e}", file=sys.stderr)
        else:
            self.send_error(404, "Not found")

    def do_DELETE(self):
        path = urlparse(self.path).path
        if not self.require_auth(path):
            return
        if path.startswith('/api/book/'):
            book_id = path[len('/api/book/'):]
            if not book_id:
                self.send_error(400, "Missing book ID"); return
            try:
                self.handle_delete_book(book_id)
            except Exception as e:
                self.send_error(500, str(e))
                print(f"DELETE {path} → 500: {e}", file=sys.stderr)
        else:
            self.send_error(404, "Not found")

    # ── API handlers ──────────────────────────────────────────────────────────

    def handle_get_books(self):
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute('SELECT * FROM books ORDER BY updated_at DESC').fetchall()
            books = []
            for row in rows:
                b = dict(row)
                b['coverUrl'] = f'/covers/{b["cover_filename"]}' if b['cover_filename'] else ''
                books.append(b)
            self.send_json(200, books)
        finally:
            conn.close()

    def handle_get_book(self, book_id):
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute('SELECT * FROM books WHERE id = ?', (book_id,)).fetchone()
            if row:
                b = dict(row)
                b['coverUrl'] = f'/covers/{b["cover_filename"]}' if b['cover_filename'] else ''
                self.send_json(200, b)
            else:
                self.send_error(404, "Book not found")
        finally:
            conn.close()

    def handle_get_cover(self, path):
        filename = path.split('/')[-1]
        if '..' in filename or '/' in filename:
            self.send_error(403, "Forbidden"); return
        cover_path = os.path.join(COVERS_DIR, filename)
        if not os.path.exists(cover_path):
            self.send_error(404, "Cover not found"); return
        with open(cover_path, 'rb') as f:
            content = f.read()
        mime, _ = mimetypes.guess_type(cover_path)
        self.send_response(200)
        self.send_header('Content-Type',   mime or 'image/jpeg')
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control',  'public, max-age=86400')
        self.end_headers()
        self.wfile.write(content)

    def handle_get_stats(self):
        """Single query for all stats — one round-trip."""
        conn = sqlite3.connect(DB_FILE)
        try:
            rows = conn.execute('''
                SELECT
                    status,
                    COUNT(*) AS cnt,
                    SUM(current_chapter) AS chapters,
                    AVG(
                        CASE WHEN total_chapters > 0
                        THEN CAST(current_chapter AS REAL) / total_chapters * 100
                        ELSE NULL END
                    ) AS avg_prog
                FROM books
                GROUP BY status
            ''').fetchall()

            total_books    = 0
            total_chapters = 0
            prog_values    = []
            by_status      = {}

            for status, cnt, chapters, avg_prog in rows:
                total_books    += cnt
                total_chapters += (chapters or 0)
                by_status[status] = cnt
                if avg_prog is not None:
                    prog_values.append(avg_prog)

            avg_progress = sum(prog_values) / len(prog_values) if prog_values else 0

            self.send_json(200, {
                'totalBooks':  total_books,
                'byStatus':    by_status,
                'totalPages':  total_chapters,
                'avgProgress': round(avg_progress, 1),
            })
        finally:
            conn.close()

    def handle_post_book(self, body):
        try:
            raw = json.loads(body.decode('utf-8'))
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON"); return

        clean, error = validate_book(raw)
        if error:
            self.send_json(400, {'error': error}); return

        # Server always generates the ID — never trust the client
        book_id = str(uuid.uuid4())

        cover_filename = ''
        if raw.get('coverData'):
            cover_filename = save_cover(raw['coverData'], book_id)

        now = int(time.time())
        conn = sqlite3.connect(DB_FILE)
        try:
            conn.execute('''
                INSERT INTO books
                    (id, title, author, status, current_chapter, total_chapters,
                     rating, category, notes, cover_filename, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ''', (
                book_id,
                clean['title'], clean['author'], clean['status'],
                clean['currentChapter'], clean['totalChapters'],
                clean['rating'], clean['category'], clean['notes'],
                cover_filename, now, now,
            ))
            conn.commit()
        finally:
            conn.close()

        self.send_json(201, {
            'success':  True,
            'id':       book_id,
            'coverUrl': f'/covers/{cover_filename}' if cover_filename else '',
        })

    def handle_update_book(self, book_id, body):
        try:
            raw = json.loads(body.decode('utf-8'))
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON"); return

        clean, error = validate_book(raw)
        if error:
            self.send_json(400, {'error': error}); return

        conn = sqlite3.connect(DB_FILE)
        try:
            row = conn.execute(
                'SELECT cover_filename FROM books WHERE id = ?', (book_id,)
            ).fetchone()
            if not row:
                self.send_error(404, "Book not found"); return

            old_cover = row[0]
            new_cover = ''
            if raw.get('coverData'):
                new_cover = save_cover(raw['coverData'], book_id, old_cover)

            now = int(time.time())
            if new_cover:
                conn.execute('''
                    UPDATE books SET title=?, author=?, status=?, current_chapter=?,
                    total_chapters=?, rating=?, category=?, notes=?,
                    cover_filename=?, updated_at=? WHERE id=?
                ''', (
                    clean['title'], clean['author'], clean['status'],
                    clean['currentChapter'], clean['totalChapters'],
                    clean['rating'], clean['category'], clean['notes'],
                    new_cover, now, book_id,
                ))
            else:
                conn.execute('''
                    UPDATE books SET title=?, author=?, status=?, current_chapter=?,
                    total_chapters=?, rating=?, category=?, notes=?,
                    updated_at=? WHERE id=?
                ''', (
                    clean['title'], clean['author'], clean['status'],
                    clean['currentChapter'], clean['totalChapters'],
                    clean['rating'], clean['category'], clean['notes'],
                    now, book_id,
                ))
            conn.commit()
        finally:
            conn.close()

        self.send_json(200, {
            'success':  True,
            'id':       book_id,
            'coverUrl': f'/covers/{new_cover}' if new_cover else None,
        })

    def handle_delete_book(self, book_id):
        conn = sqlite3.connect(DB_FILE)
        try:
            row = conn.execute(
                'SELECT cover_filename FROM books WHERE id = ?', (book_id,)
            ).fetchone()
            if not row:
                self.send_error(404, "Book not found"); return

            cover_filename = row[0]
            conn.execute('DELETE FROM books WHERE id = ?', (book_id,))
            conn.commit()
        finally:
            conn.close()

        # Clean up cover file after successful DB delete
        if cover_filename:
            cover_path = os.path.join(COVERS_DIR, cover_filename)
            if os.path.exists(cover_path):
                try:
                    os.remove(cover_path)
                except OSError as e:
                    print(f"Could not remove cover {cover_filename}: {e}", file=sys.stderr)

        self.send_json(200, {'success': True})

    # ── Static files ──────────────────────────────────────────────────────────

    def handle_static_file(self, path):
        path = path.lstrip('/') or 'index.html'
        if '..' in path:
            self.send_error(403, "Forbidden"); return
        if not os.path.exists(path):
            self.send_error(404, "Not found"); return
        mime, _ = mimetypes.guess_type(path)
        with open(path, 'rb') as f:
            content = f.read()
        self.send_response(200)
        self.send_header('Content-Type',   mime or 'text/plain')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def send_json(self, status, data, headers=None):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type',   'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        for k, v in (headers or []):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_redirect(self, location):
        self.send_response(302)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        self.end_headers()

    # ── Auth ──────────────────────────────────────────────────────────────────

    def get_token(self):
        raw = self.headers.get('Cookie')
        if not raw:
            return None
        c = SimpleCookie()
        try:
            c.load(raw)
        except Exception:
            return None
        return c['session'].value if 'session' in c else None

    def current_user(self):
        token = self.get_token()
        if not token:
            return None
        conn = sqlite3.connect(DB_FILE)
        try:
            row = conn.execute(
                'SELECT u.id, u.email, s.created_at, u.avatar FROM sessions s '
                'JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
                (hash_token(token),)
            ).fetchone()
            if not row:
                return None
            if int(time.time()) - (row[2] or 0) > SESSION_TTL:
                conn.execute('DELETE FROM sessions WHERE token_hash = ?', (hash_token(token),))
                conn.commit()
                return None
            return {'id': row[0], 'email': row[1], 'avatar': row[3] or ''}
        finally:
            conn.close()

    def require_auth(self, path):
        """Return the user, or respond 401/redirect and return None."""
        user = self.current_user()
        if user:
            return user
        if path.startswith('/api/') or path.startswith('/covers/'):
            self.send_json(401, {'error': 'Not authenticated'})
        else:
            self.send_redirect('/login.html')
        return None

    def start_session(self, user_id):
        token = secrets.token_urlsafe(32)
        conn = sqlite3.connect(DB_FILE)
        conn.execute('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)',
                     (hash_token(token), user_id, int(time.time())))
        conn.commit()
        conn.close()
        return [('Set-Cookie', f'session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_TTL}')]

    def handle_signup(self, body):
        try:
            data = json.loads(body or b'{}')
        except ValueError:
            self.send_json(400, {'error': 'Invalid JSON'}); return
        email, password, err = validate_credentials(data)
        if err:
            self.send_json(400, {'error': err}); return
        salt    = os.urandom(16)
        user_id = str(uuid.uuid4())
        conn = sqlite3.connect(DB_FILE)
        try:
            conn.execute('INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)',
                         (user_id, email, hash_password(password, salt), salt.hex(), int(time.time())))
            conn.commit()
        except sqlite3.IntegrityError:
            self.send_json(409, {'error': 'Email already registered'}); return
        finally:
            conn.close()
        self.send_json(201, {'success': True}, self.start_session(user_id))

    def handle_login(self, body):
        try:
            data = json.loads(body or b'{}')
        except ValueError:
            self.send_json(400, {'error': 'Invalid JSON'}); return
        email    = str(data.get('email', '')).strip().lower()
        password = str(data.get('password', ''))[:128]
        conn = sqlite3.connect(DB_FILE)
        row = conn.execute('SELECT id, password_hash, salt FROM users WHERE email = ?', (email,)).fetchone()
        conn.close()
        # Always hash, so response time does not reveal whether the email exists
        salt   = bytes.fromhex(row[2]) if row else b'\x00' * 16
        digest = hash_password(password, salt)
        if not row or not hmac.compare_digest(digest, row[1]):
            self.send_json(401, {'error': 'Invalid email or password'}); return
        self.send_json(200, {'success': True}, self.start_session(row[0]))

    def handle_logout(self):
        token = self.get_token()
        if token:
            conn = sqlite3.connect(DB_FILE)
            conn.execute('DELETE FROM sessions WHERE token_hash = ?', (hash_token(token),))
            conn.commit()
            conn.close()
        self.send_json(200, {'success': True},
                       [('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')])

    def log_message(self, fmt, *args):
        """Only log 4xx/5xx — suppress noisy 200s in the terminal."""
        status = str(args[1]) if len(args) > 1 else ''
        if status[:1] in ('4', '5'):
            print(f"[{self.address_string()}] {fmt % args}", file=sys.stderr)


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    init_database()
    httpd = HTTPServer(('', PORT), BookTrackerHandler)
    print(f"Book Tracker running → http://localhost:{PORT}")
    print(f"DB: {DB_FILE}   Covers: {COVERS_DIR}/")
    print("Ctrl+C to stop\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.server_close()


if __name__ == '__main__':
    main()
