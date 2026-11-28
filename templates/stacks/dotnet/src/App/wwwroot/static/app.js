// The start page's script. It asks the API who is signed in (GET /api/me) and shows:
// - the user menu: name, email, roles with what each may do, Sign out and Sign in as another user
//   (on your computer, the fake user from DEV_FAKE_USER and a note instead of the links);
// - for a user without a role, a page that says to ask the app's owner.
// Build the app's pages from here. Put data into the page with textContent, never innerHTML.

const $ = (id) => document.getElementById(id);

async function loadMe() {
  // Same origin: the platform's sign-in cookie goes along, no tokens in the browser.
  const response = await fetch('/api/me', { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const error = new Error(`GET /api/me answered ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function setMenuOpen(open) {
  $('user-menu-panel').hidden = !open;
  $('user-menu-button').setAttribute('aria-expanded', String(open));
}

function showUserMenu(me) {
  $('user-menu-button-name').textContent = me.name;
  $('user-name').textContent = me.name;
  if (me.email) {
    $('user-email').textContent = me.email;
    $('user-email').hidden = false;
  }

  const list = $('user-roles');
  list.replaceChildren(
    ...me.roles.map((role) => {
      const item = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = role.displayName;
      item.append(name);
      if (role.description) {
        const description = document.createElement('span');
        description.className = 'muted';
        description.textContent = `: ${role.description}`;
        item.append(description);
      }
      if (!role.level) {
        const note = document.createElement('span');
        note.className = 'muted';
        note.textContent = ' (gives no access in this app yet)';
        item.append(note);
      }
      return item;
    }),
  );
  list.hidden = me.roles.length === 0;
  $('user-no-roles').hidden = me.roles.length > 0;
  $('user-actions').hidden = me.isDevUser;
  $('user-local-note').hidden = !me.isDevUser;
  $('user-menu').hidden = false;

  // Escape closes the menu and puts the focus back on its button; a click elsewhere closes it.
  $('user-menu-button').addEventListener('click', () => setMenuOpen($('user-menu-panel').hidden));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('user-menu-panel').hidden) {
      setMenuOpen(false);
      $('user-menu-button').focus();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!$('user-menu').contains(event.target)) setMenuOpen(false);
  });
}

function showPage(me) {
  $('status').hidden = true;
  if (me.level) {
    $('home-name').textContent = me.name;
    $('home').hidden = false;
  } else {
    $('no-role-platform').hidden = me.isDevUser;
    $('no-role-local').hidden = !me.isDevUser;
    $('no-role').hidden = false;
  }
}

function showError(error) {
  const status = $('status');
  status.setAttribute('role', 'alert');
  status.textContent =
    error.status === 401
      ? 'You are not signed in. On your computer, set DEV_FAKE_USER in your local settings (README.md).'
      : 'Could not load your profile.';
}

loadMe()
  .then((me) => {
    showUserMenu(me);
    showPage(me);
  })
  .catch(showError);
