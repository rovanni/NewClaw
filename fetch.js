fetch('http://localhost:3090/api/traces')
  .then(res => res.json())
  .then(data => {
    // Show only the last 15 traces
    console.log(JSON.stringify(data.traces.slice(0, 15), null, 2));
  }).catch(e => console.error(e));
