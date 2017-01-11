# nibe-fetcher

## example
```
const Fetcher = require('./')

var f = new Fetcher({
  clientId: 'xxx',
  clientSecret: 'yyy',
  systemId: zzz
})

f.on('data', (data) => {
  console.log(JSON.stringify(data, null, ' '))
})

f.on('error', (data) => {
  console.error('Error:', data)
})

```