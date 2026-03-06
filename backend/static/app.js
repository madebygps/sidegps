// SideGPS — NYC Transit PWA
(function () {
  'use strict';

  // Backend URL — same origin for dev, configure for production
  var API_BASE = '';

  // MTA route color map
  var ROUTE_COLORS = {
    '1': '#EE352E', '2': '#EE352E', '3': '#EE352E',
    '4': '#00933C', '5': '#00933C', '6': '#00933C',
    '7': '#B933AD',
    'A': '#0039A6', 'C': '#0039A6', 'E': '#0039A6',
    'B': '#FF6319', 'D': '#FF6319', 'F': '#FF6319', 'M': '#FF6319',
    'G': '#6CBE45',
    'J': '#996633', 'Z': '#996633',
    'L': '#A7A9AC',
    'N': '#FCCC0A', 'Q': '#FCCC0A', 'R': '#FCCC0A', 'W': '#FCCC0A',
    'S': '#808183',
    'SIR': '#0039A6'
  };

  // Routes that need dark text on their badge
  var DARK_TEXT_ROUTES = { 'N': 1, 'Q': 1, 'R': 1, 'W': 1 };

  var refreshTimer = null;
  var currentLat = null;
  var currentLon = null;
  var cachedNearby = null;
  var cachedAlerts = null;

  // --- DOM helpers ---
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'className') node.className = attrs[k];
        else if (k === 'textContent') node.textContent = attrs[k];
        else if (k === 'innerHTML') node.innerHTML = attrs[k];
        else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    if (children) {
      children.forEach(function (c) {
        if (typeof c === 'string') node.appendChild(document.createTextNode(c));
        else if (c) node.appendChild(c);
      });
    }
    return node;
  }

  // --- Tab switching ---
  function initTabs() {
    var tabs = $$('#tab-bar .tab');
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = btn.getAttribute('data-tab');
        tabs.forEach(function (t) { t.classList.remove('active'); });
        btn.classList.add('active');
        $$('.tab-content').forEach(function (s) { s.classList.remove('active'); });
        $('#tab-' + target).classList.add('active');

        if (target === 'nearby') loadNearby();
        if (target === 'alerts') loadAlerts();
      });
    });
  }

  // --- Route badge ---
  function routeBadge(route) {
    var color = ROUTE_COLORS[route] || '#555';
    var dark = DARK_TEXT_ROUTES[route] ? ' dark-text' : '';
    return el('span', {
      className: 'route-badge' + dark,
      textContent: route,
      style: 'background:' + color
    });
  }

  // --- Direction label ---
  function dirLabel(directionId, route) {
    if (directionId === undefined || directionId === null) return '';
    // General: 0 = Manhattan-bound (downtown/south), 1 = uptown/north/outbound
    // Varies by route but this covers most cases
    var labels0, labels1;
    if ('A C E B D F M J Z'.indexOf(route) !== -1) {
      labels1 = '↑ Uptown';
      labels0 = '↓ Downtown';
    } else if (route === 'G') {
      labels1 = '↑ Queens';
      labels0 = '↓ Brooklyn';
    } else if ('N Q R W'.indexOf(route) !== -1) {
      labels1 = '↑ Uptown';
      labels0 = '↓ Downtown';
    } else if (route === 'L') {
      labels1 = '← 8 Av';
      labels0 = '→ Canarsie';
    } else if (route === '7') {
      labels1 = '← Manhattan';
      labels0 = '→ Queens';
    } else if (route === 'S' || route === 'SIR') {
      labels1 = '→';
      labels0 = '←';
    } else {
      labels1 = '↑ Uptown';
      labels0 = '↓ Downtown';
    }
    return directionId === 0 ? labels0 : labels1;
  }

  // --- Arrival row ---
  function arrivalRow(arr) {
    var route = arr.route_id || arr.route || '';
    var mins = arr.minutes_away != null ? Math.round(arr.minutes_away) : (arr.minutes != null ? arr.minutes : '?');
    var isLive = true;
    var timeText = isLive ? mins + ' min' : '~' + mins + ' min';
    var timeClass = 'arrival-time ' + (isLive ? 'live' : 'scheduled');
    var dir = dirLabel(arr.direction != null ? arr.direction : arr.direction_id, route);

    var row = el('div', { className: 'arrival-row' }, [
      routeBadge(route),
      el('span', { className: 'arrival-dir', textContent: dir }),
      el('span', { className: timeClass, textContent: timeText })
    ]);
    return row;
  }

  // --- Station card ---
  function stationCard(station) {
    var distMeters = station.distance_m || 0;
    var walkMin = Math.max(1, Math.round(distMeters / 80));
    var distText = walkMin + ' min walk';

    var card = el('div', { className: 'station-card' });
    card.appendChild(el('div', { className: 'station-header' }, [
      el('span', { className: 'station-name', textContent: station.name }),
      el('span', { className: 'station-dist', textContent: distText })
    ]));

    var arrivals = station.arrivals || [];
    if (arrivals.length === 0) {
      card.appendChild(el('div', { className: 'no-arrivals', textContent: 'No upcoming trains' }));
    } else {
      arrivals.slice(0, 6).forEach(function (a) {
        card.appendChild(arrivalRow(a));
      });
    }

    card.addEventListener('click', function () {
      openArrivalBoard(station.id || station.stop_id, station.name);
    });

    return card;
  }

  // --- Fetch with timeout ---
  function apiFetch(path) {
    var url = API_BASE + path;
    return Promise.race([
      fetch(url),
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('timeout')); }, 10000);
      })
    ]).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // --- Nearby tab ---
  function loadNearby() {
    if (currentLat === null) {
      requestLocation();
      return;
    }
    var status = $('#nearby-status');
    var container = $('#nearby-stations');
    status.textContent = 'Finding nearby stations…';
    status.className = 'status-msg';
    status.classList.remove('hidden');

    apiFetch('/api/nearby?lat=' + currentLat + '&lon=' + currentLon + '&limit=5')
      .then(function (data) {
        var stations = data.stations || data;
        cachedNearby = stations;
        try { localStorage.setItem('cached_nearby', JSON.stringify(stations)); } catch (e) { /* ignore */ }
        renderNearby(stations);
      })
      .catch(function () {
        if (cachedNearby) {
          renderNearby(cachedNearby);
          showError(status, 'Can\'t reach transit server. Showing cached data.');
        } else {
          var cached = null;
          try { cached = JSON.parse(localStorage.getItem('cached_nearby')); } catch (e) { /* ignore */ }
          if (cached) {
            renderNearby(cached);
            showError(status, 'Can\'t reach transit server. Showing cached data.');
          } else {
            showError(status, 'Can\'t reach transit server.');
            container.innerHTML = '';
            container.appendChild(retryButton(loadNearby));
          }
        }
      });
  }

  function renderNearby(stations) {
    var status = $('#nearby-status');
    var container = $('#nearby-stations');
    container.innerHTML = '';
    if (!stations || stations.length === 0) {
      status.textContent = 'No stations found nearby.';
      status.className = 'status-msg';
      return;
    }
    status.classList.add('hidden');
    stations.forEach(function (s) {
      container.appendChild(stationCard(s));
    });
  }

  function showError(statusEl, msg) {
    statusEl.textContent = msg;
    statusEl.className = 'error-msg';
    statusEl.classList.remove('hidden');
  }

  function retryButton(fn) {
    return el('div', { style: 'text-align:center' }, [
      el('button', { className: 'btn-retry', textContent: 'Retry', onClick: fn })
    ]);
  }

  // --- Geolocation ---
  function requestLocation() {
    var status = $('#nearby-status');
    if (!navigator.geolocation) {
      showError(status, 'Geolocation not supported by this browser.');
      return;
    }
    status.textContent = 'Getting your location…';
    status.className = 'status-msg';

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        currentLat = pos.coords.latitude;
        currentLon = pos.coords.longitude;
        loadNearby();
        startAutoRefresh();
      },
      function (err) {
        if (err.code === 1) {
          showError(status, 'Location access denied. Enable location in settings.');
        } else {
          showError(status, 'Could not get location. Please try again.');
        }
        $('#nearby-stations').innerHTML = '';
        $('#nearby-stations').appendChild(retryButton(requestLocation));
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }
    );
  }

  function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(function () {
      if ($('#tab-nearby').classList.contains('active') && currentLat !== null) {
        loadNearby();
      }
    }, 30000);
  }

  // --- Arrival board overlay ---
  function openArrivalBoard(stopId, name) {
    var overlay = $('#arrival-overlay');
    var board = $('#arrival-board');
    $('#overlay-title').textContent = name;
    board.innerHTML = '<div class="status-msg">Loading arrivals…</div>';
    overlay.classList.remove('hidden');

    apiFetch('/api/arrivals/' + encodeURIComponent(stopId))
      .then(function (data) {
        var arrivals = data.arrivals || data;
        board.innerHTML = '';
        if (!arrivals || arrivals.length === 0) {
          board.innerHTML = '<div class="status-msg">No upcoming arrivals.</div>';
          return;
        }
        arrivals.forEach(function (a) {
          board.appendChild(arrivalRow(a));
        });
      })
      .catch(function () {
        board.innerHTML = '<div class="error-msg">Failed to load arrivals.</div>';
        board.appendChild(retryButton(function () { openArrivalBoard(stopId, name); }));
      });
  }

  function closeOverlay() {
    $('#arrival-overlay').classList.add('hidden');
  }

  // --- Directions tab ---
  function initDirections() {
    $('#btn-locate').addEventListener('click', function () {
      if (currentLat !== null) {
        $('#dir-from').value = 'Current Location (' + currentLat.toFixed(4) + ', ' + currentLon.toFixed(4) + ')';
      } else {
        $('#dir-from').value = '📍 Getting location…';
        navigator.geolocation.getCurrentPosition(
          function (pos) {
            currentLat = pos.coords.latitude;
            currentLon = pos.coords.longitude;
            $('#dir-from').value = 'Current Location (' + currentLat.toFixed(4) + ', ' + currentLon.toFixed(4) + ')';
          },
          function () {
            $('#dir-from').value = '';
            $('#dir-from').placeholder = 'Could not get location';
          },
          { timeout: 10000 }
        );
      }
    });

    $('#directions-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var result = $('#directions-result');
      result.innerHTML = '<p class="status-msg">Coming soon — route planning will be available once the trip planner backend is configured.</p>';
    });
  }

  // --- Alerts tab ---
  function loadAlerts() {
    var status = $('#alerts-status');
    var list = $('#alerts-list');
    status.textContent = 'Loading alerts…';
    status.className = 'status-msg';
    status.classList.remove('hidden');

    apiFetch('/api/alerts')
      .then(function (data) {
        var alerts = data.alerts || data;
        cachedAlerts = alerts;
        try { localStorage.setItem('cached_alerts', JSON.stringify(alerts)); } catch (e) { /* ignore */ }
        renderAlerts(alerts);
      })
      .catch(function () {
        if (cachedAlerts) {
          renderAlerts(cachedAlerts);
          showError(status, 'Can\'t reach transit server. Showing cached data.');
        } else {
          var cached = null;
          try { cached = JSON.parse(localStorage.getItem('cached_alerts')); } catch (e) { /* ignore */ }
          if (cached) {
            renderAlerts(cached);
            showError(status, 'Can\'t reach transit server. Showing cached data.');
          } else {
            showError(status, 'Can\'t reach transit server.');
            list.innerHTML = '';
            list.appendChild(retryButton(loadAlerts));
          }
        }
      });
  }

  function renderAlerts(alerts) {
    var status = $('#alerts-status');
    var list = $('#alerts-list');
    list.innerHTML = '';
    if (!alerts || alerts.length === 0) {
      status.textContent = 'No active alerts.';
      status.className = 'status-msg';
      return;
    }
    status.classList.add('hidden');
    alerts.forEach(function (alert) {
      var card = el('div', { className: 'alert-card' });

      // Affected route badges
      var routes = alert.affected_routes || alert.routes || [];
      if (routes.length > 0) {
        var badgeRow = el('div', { className: 'alert-routes' });
        routes.forEach(function (r) { badgeRow.appendChild(routeBadge(r)); });
        card.appendChild(badgeRow);
      }

      card.appendChild(el('div', { className: 'alert-header', textContent: alert.header_text || alert.header || alert.title || 'Service Alert' }));
      if (alert.description_text || alert.description) {
        var desc = alert.description_text || alert.description;
        card.appendChild(el('div', { className: 'alert-desc', textContent: desc.substring(0, 300) }));
      }
      list.appendChild(card);
    });
  }

  // --- Init ---
  function init() {
    initTabs();
    initDirections();
    $('#overlay-back').addEventListener('click', closeOverlay);
    requestLocation();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
