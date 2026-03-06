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
  var dirMode = 'transit';

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
    var header = el('div', { className: 'station-header' }, [
      el('span', { className: 'station-name', textContent: station.name }),
      el('span', { className: 'station-dist', textContent: distText })
    ]);
    if (station.lat && station.lon) {
      var mapLink = el('a', {
        className: 'map-link',
        href: 'geo:' + station.lat + ',' + station.lon + '?q=' + station.lat + ',' + station.lon + '(' + encodeURIComponent(station.name) + ')',
        textContent: '📍',
        title: 'Open in map'
      });
      mapLink.setAttribute('target', '_blank');
      mapLink.addEventListener('click', function (e) { e.stopPropagation(); });
      header.appendChild(mapLink);
    }
    card.appendChild(header);

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
    // Also load Citi Bike
    loadCitiBike();
  }

  // --- Citi Bike ---
  function loadCitiBike() {
    if (currentLat === null) return;
    var section = $('#citibike-section');
    var container = $('#citibike-stations');

    apiFetch('/api/citibike?lat=' + currentLat + '&lon=' + currentLon + '&limit=3')
      .then(function (data) {
        var stations = data.stations || [];
        if (stations.length === 0) {
          section.classList.add('hidden');
          return;
        }
        container.innerHTML = '';
        stations.forEach(function (s) {
          var distMin = Math.max(1, Math.round((s.distance_m || 0) / 80));
          var bikesText = s.bikes + ' 🚲';
          if (s.ebikes > 0) bikesText += '  ' + s.ebikes + ' ⚡';
          bikesText += '  ' + s.docks + ' docks';

          var card = el('div', { className: 'citibike-card' }, [
            el('div', { className: 'citibike-header' }, [
              el('span', { className: 'citibike-name', textContent: s.name }),
              el('span', { className: 'station-dist', textContent: distMin + ' min walk' }),
              el('a', {
                className: 'map-link',
                href: 'geo:' + s.lat + ',' + s.lon + '?q=' + s.lat + ',' + s.lon + '(' + encodeURIComponent(s.name) + ')',
                textContent: '📍',
                title: 'Open in map'
              })
            ]),
            el('div', { className: 'citibike-avail' + (s.bikes === 0 ? ' empty' : ''), textContent: bikesText })
          ]);
          card.querySelector('.map-link').setAttribute('target', '_blank');
          card.querySelector('.map-link').addEventListener('click', function (e) { e.stopPropagation(); });
          container.appendChild(card);
        });
        section.classList.remove('hidden');
      })
      .catch(function () {
        section.classList.add('hidden');
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
  // On degoogled Android (like Sidephone), there's no Google Location Services.
  // The browser Geolocation API depends on the OS location provider, which without
  // GMS has NO network location — only raw GPS. Raw GPS needs clear sky view and
  // can take 30-120s for a cold fix. We use a 3-tier fallback:
  //   1. Try browser geolocation (GPS) with generous timeout
  //   2. Fall back to IP-based geolocation (city-level, but instant)
  //   3. Manual station picker as last resort

  function requestLocation() {
    var status = $('#nearby-status');
    var container = $('#nearby-stations');
    container.innerHTML = '';

    if (!navigator.geolocation) {
      ipFallback();
      return;
    }

    status.textContent = 'Acquiring GPS… (may take a minute without Google services)';
    status.className = 'status-msg';

    // Also start IP fallback in parallel — whichever wins first
    var resolved = false;

    // IP geolocation runs immediately as backup
    ipGeolocate(function (lat, lon) {
      if (!resolved) {
        resolved = true;
        currentLat = lat;
        currentLon = lon;
        loadNearby();
        startAutoRefresh();
        // Keep trying GPS in background for better accuracy
        tryGpsUpgrade();
      }
    });

    // GPS attempt — may succeed and override IP location
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        if (!resolved || pos.coords.accuracy < 500) {
          resolved = true;
          currentLat = pos.coords.latitude;
          currentLon = pos.coords.longitude;
          loadNearby();
          startAutoRefresh();
        }
      },
      function () {
        // GPS failed — if IP also hasn't resolved, show manual picker
        if (!resolved) {
          showManualFallback();
        }
      },
      { enableHighAccuracy: true, timeout: 90000, maximumAge: 300000 }
    );

    // If nothing resolves in 8 seconds, show manual fallback alongside loading
    setTimeout(function () {
      if (!resolved) {
        status.textContent = 'Still waiting for location…';
        showManualFallback();
      }
    }, 8000);
  }

  function tryGpsUpgrade() {
    // Keep watching GPS in background — if we get a fix, silently upgrade
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        if (pos.coords.accuracy < 200) {
          currentLat = pos.coords.latitude;
          currentLon = pos.coords.longitude;
          // Only reload if user is still on nearby tab
          if ($('#tab-nearby').classList.contains('active')) {
            loadNearby();
          }
        }
      },
      function () { /* ignore */ },
      { enableHighAccuracy: true, timeout: 120000, maximumAge: 60000 }
    );
  }

  function ipGeolocate(callback) {
    // Free IP geolocation APIs — no key needed, city-level accuracy (~1-5km)
    // Good enough to find the right neighborhood in NYC
    var apis = [
      {
        url: 'https://ipapi.co/json/',
        parse: function (d) { return { lat: d.latitude, lon: d.longitude }; }
      },
      {
        url: 'https://ipwho.is/',
        parse: function (d) { return { lat: d.latitude, lon: d.longitude }; }
      }
    ];

    var tried = 0;
    function tryNext() {
      if (tried >= apis.length) return;
      var api = apis[tried++];
      fetch(api.url, { timeout: 5000 })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var loc = api.parse(data);
          if (loc.lat && loc.lon && Math.abs(loc.lat) > 0.1) {
            callback(loc.lat, loc.lon);
          } else {
            tryNext();
          }
        })
        .catch(function () { tryNext(); });
    }
    tryNext();
  }

  function showManualFallback() {
    var container = $('#nearby-stations');
    // Don't clear if we already have station cards rendered
    if (container.querySelector('.station-card')) return;

    // Quick-pick popular stations
    var hubs = [
      { name: 'Times Sq-42 St', lat: 40.7559, lon: -73.9870 },
      { name: '14 St-Union Sq', lat: 40.7359, lon: -73.9906 },
      { name: 'Grand Central-42 St', lat: 40.7527, lon: -73.9772 },
      { name: 'Penn Station', lat: 40.7506, lon: -73.9935 },
      { name: 'Atlantic Av-Barclays', lat: 40.6862, lon: -73.9787 },
      { name: 'Jay St-MetroTech', lat: 40.6923, lon: -73.9872 },
      { name: 'Fulton St', lat: 40.7092, lon: -74.0065 },
      { name: 'Jackson Hts-Roosevelt', lat: 40.7466, lon: -73.8913 },
      { name: 'W 4 St-Washington Sq', lat: 40.7322, lon: -74.0009 },
      { name: '59 St-Columbus Circle', lat: 40.7684, lon: -73.9816 },
    ];

    var label = el('div', { className: 'status-msg', textContent: 'Pick a station area:' });
    container.appendChild(label);

    hubs.forEach(function (hub) {
      var btn = el('button', {
        className: 'station-pick-btn',
        textContent: hub.name,
        onClick: function () {
          currentLat = hub.lat;
          currentLon = hub.lon;
          container.innerHTML = '';
          loadNearby();
          startAutoRefresh();
        }
      });
      container.appendChild(btn);
    });

    var retryRow = el('div', { style: 'text-align:center;margin-top:8px' }, [
      el('button', { className: 'btn-retry', textContent: '🔄 Retry GPS', onClick: function () {
        container.innerHTML = '';
        requestLocation();
      }})
    ]);
    container.appendChild(retryRow);
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
  var fromCoords = null; // {lat, lon}
  var toCoords = null;
  var searchTimer = null;

  function initDirections() {
    $('#btn-locate').addEventListener('click', function () {
      if (currentLat !== null) {
        fromCoords = { lat: currentLat, lon: currentLon };
        $('#dir-from').value = 'My Location';
        $('#dir-from').classList.add('has-coords');
      } else {
        $('#dir-from').value = '📍 Getting location…';
        ipGeolocate(function (lat, lon) {
          currentLat = lat;
          currentLon = lon;
          fromCoords = { lat: lat, lon: lon };
          $('#dir-from').value = 'My Location';
          $('#dir-from').classList.add('has-coords');
        });
      }
    });

    // Station autocomplete for both fields
    setupAutocomplete('dir-from', 'dir-from-suggestions', function (station) {
      fromCoords = { lat: station.lat, lon: station.lon };
    });
    setupAutocomplete('dir-to', 'dir-to-suggestions', function (station) {
      toCoords = { lat: station.lat, lon: station.lon };
    });

    $('#directions-form').addEventListener('submit', function (e) {
      e.preventDefault();
      searchDirections();
    });

    // Mode picker
    $$('.mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $$('.mode-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        dirMode = btn.getAttribute('data-mode');
      });
    });
  }

  function setupAutocomplete(inputId, suggestionsId, onSelect) {
    var input = $('#' + inputId);
    var sugBox = $('#' + suggestionsId);

    input.addEventListener('input', function () {
      input.classList.remove('has-coords');
      if (inputId === 'dir-from') fromCoords = null;
      else toCoords = null;

      clearTimeout(searchTimer);
      var q = input.value.trim();
      if (q.length < 2) {
        sugBox.classList.add('hidden');
        sugBox.innerHTML = '';
        return;
      }
      searchTimer = setTimeout(function () {
        apiFetch('/api/search-places?q=' + encodeURIComponent(q))
          .then(function (results) {
            sugBox.innerHTML = '';
            if (!results || results.length === 0) {
              sugBox.classList.add('hidden');
              return;
            }
            results.forEach(function (s) {
              var item = el('div', {
                className: 'suggestion-item',
                textContent: s.name,
                onClick: function () {
                  input.value = s.name;
                  input.classList.add('has-coords');
                  sugBox.classList.add('hidden');
                  onSelect(s);
                }
              });
              sugBox.appendChild(item);
            });
            sugBox.classList.remove('hidden');
          })
          .catch(function () { sugBox.classList.add('hidden'); });
      }, 250);
    });

    // Hide suggestions on blur (with delay so clicks register)
    input.addEventListener('blur', function () {
      setTimeout(function () { sugBox.classList.add('hidden'); }, 200);
    });
  }

  function searchDirections() {
    var result = $('#directions-result');

    if (!fromCoords || !toCoords) {
      result.innerHTML = '';
      result.appendChild(el('div', { className: 'error-msg', textContent: 'Select a station or use 📍 for both From and To.' }));
      return;
    }

    // Walk/bike mode: compute locally (no API needed)
    if (dirMode === 'walk' || dirMode === 'bike') {
      var dist = haversineJS(fromCoords.lat, fromCoords.lon, toCoords.lat, toCoords.lon);
      var speed = dirMode === 'walk' ? 80 : 250; // meters per minute
      var mins = Math.max(1, Math.round(dist / speed));
      var icon = dirMode === 'walk' ? '🚶' : '🚲';
      var distText = dist > 1000 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m';

      result.innerHTML = '';
      var card = el('div', { className: 'itinerary-card' });
      card.appendChild(el('div', { className: 'itin-header' }, [
        el('span', { className: 'itin-duration', textContent: mins + ' min' }),
        el('span', { className: 'itin-transfers', textContent: icon + ' ' + distText })
      ]));
      if (dirMode === 'bike') {
        // Show nearest Citi Bike stations to origin
        card.appendChild(el('div', { className: 'leg-walk', textContent: '💡 Check Nearby tab for Citi Bike availability' }));
      }
      result.appendChild(card);
      return;
    }

    result.innerHTML = '';
    result.appendChild(el('div', { className: 'status-msg', textContent: 'Finding routes…' }));

    var url = '/api/directions?from_lat=' + fromCoords.lat + '&from_lon=' + fromCoords.lon
      + '&to_lat=' + toCoords.lat + '&to_lon=' + toCoords.lon;

    apiFetch(url)
      .then(function (data) {
        if (data.error) {
          result.innerHTML = '';
          result.appendChild(el('div', { className: 'error-msg', textContent: 'Routing error: ' + data.error }));
          return;
        }
        renderItineraries(data.itineraries || []);
      })
      .catch(function () {
        result.innerHTML = '';
        result.appendChild(el('div', { className: 'error-msg', textContent: 'Could not reach routing server.' }));
        result.appendChild(retryButton(searchDirections));
      });
  }

  function haversineJS(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    var dp = (lat2 - lat1) * Math.PI / 180;
    var dl = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dp/2) * Math.sin(dp/2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2) * Math.sin(dl/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function renderItineraries(itineraries) {
    var result = $('#directions-result');
    result.innerHTML = '';

    if (itineraries.length === 0) {
      result.appendChild(el('div', { className: 'status-msg', textContent: 'No routes found.' }));
      return;
    }

    itineraries.forEach(function (itin, idx) {
      var totalMin = Math.round(itin.duration / 60);
      var transfers = itin.transfers;

      // Build summary line with transit route badges
      var transitRoutes = [];
      itin.legs.forEach(function (leg) {
        if (leg.mode !== 'WALK' && leg.route) {
          transitRoutes.push(leg.route);
        }
      });

      var card = el('div', { className: 'itinerary-card' });

      // Header row: duration + transfers + route badges
      var headerRow = el('div', { className: 'itin-header' });
      headerRow.appendChild(el('span', { className: 'itin-duration', textContent: totalMin + ' min' }));
      if (transfers > 0) {
        headerRow.appendChild(el('span', { className: 'itin-transfers', textContent: transfers + ' transfer' + (transfers > 1 ? 's' : '') }));
      }
      transitRoutes.forEach(function (r) {
        headerRow.appendChild(routeBadge(r));
      });
      card.appendChild(headerRow);

      // Time range
      var startT = formatTime(itin.start_time);
      var endT = formatTime(itin.end_time);
      if (startT && endT) {
        card.appendChild(el('div', { className: 'itin-time-range', textContent: startT + ' → ' + endT }));
      }

      // Leg details
      var legsContainer = el('div', { className: 'itin-legs' });
      itin.legs.forEach(function (leg) {
        var legMin = Math.round(leg.duration / 60);
        var legEl;

        if (leg.mode === 'WALK') {
          var distM = Math.round(leg.distance || 0);
          var walkText = '🚶 Walk ' + legMin + ' min';
          if (distM > 0) walkText += ' (' + distM + 'm)';
          if (leg.to_name && leg.to_name !== 'END') walkText += ' to ' + leg.to_name;
          legEl = el('div', { className: 'leg-walk', textContent: walkText });
        } else {
          legEl = el('div', { className: 'leg-transit' });
          var legHeader = el('div', { className: 'leg-transit-header' });
          if (leg.route) legHeader.appendChild(routeBadge(leg.route));

          var modeIcon = leg.mode === 'SUBWAY' ? '🚇' : leg.mode === 'BUS' ? '🚌' : '🚆';
          var routeName = leg.route_long || leg.route || leg.mode;
          legHeader.appendChild(el('span', { textContent: modeIcon + ' ' + routeName + ' · ' + legMin + ' min' }));
          legEl.appendChild(legHeader);

          if (leg.headsign) {
            legEl.appendChild(el('div', { className: 'leg-headsign', textContent: '→ ' + leg.headsign }));
          }

          var stopLine = '';
          if (leg.from_name && leg.from_name !== 'START') stopLine += leg.from_name;
          if (leg.to_name && leg.to_name !== 'END') stopLine += ' → ' + leg.to_name;
          if (leg.num_stops > 0) stopLine += ' (' + leg.num_stops + ' stops)';
          if (stopLine) {
            legEl.appendChild(el('div', { className: 'leg-stops', textContent: stopLine }));
          }

          var legTime = formatTime(leg.start_time);
          if (legTime) {
            legEl.appendChild(el('div', { className: 'leg-time', textContent: 'Departs ' + legTime }));
          }
        }
        legsContainer.appendChild(legEl);
      });
      card.appendChild(legsContainer);
      result.appendChild(card);
    });
  }

  function formatTime(isoStr) {
    if (!isoStr) return '';
    try {
      var d = new Date(isoStr);
      var h = d.getHours();
      var m = d.getMinutes();
      var ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
    } catch (e) { return ''; }
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
