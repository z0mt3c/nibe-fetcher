const EventEmitter = require('events')
const Hoek = require('hoek')
const Wreck = require('wreck')
const Joi = require('joi')
const querystring = require('querystring')
const prompt = require('prompt')
const Configstore = require('configstore')
const async = require('async')
const info = require('./package.json')

const defaultOptions = {
  clientId: null,
  clientSecret: null,
  systemId: null,
  pattern: /<tr>\s*<td>\s*([^<]+)<span[^>]+>([^<]*)<\/span>\s*<\/td>\s*<td>\s*<span class="AutoUpdateValue ID([0-9]*)[^>]+>([^<]*)<\/span>\s*<\/td>\s*<\/tr>/g,
  baseUrl: 'https://api.nibeuplink.com',
  redirectUri: 'http://z0mt3c.github.io/nibe.html',
  scope: 'READSYSTEM',
  autoStart: true,
  timeout: 60000,
  maxBytes: 1048576,
  followRedirects: 2,
  userAgent: [info.name, info.version].join(' '),
  parameters: {
    '10001': 'ventilation_fan_speed',
    '10012': 'cpr_info_ep14_blocked',
    '10033': 'addition_blocked',
    '40004': 'status_outdoor_temp',
    '40008': 'system_1_heat_medium_flow',
    '40012': 'cpr_info_ep14_condenser_return',
    '40013': 'status_hot_water_top',
    '40014': 'status_hot_water_charging',
    '40017': 'cpr_info_ep14_condenser_out',
    '40018': 'cpr_info_ep14_hot_gas',
    '40019': 'cpr_info_ep14_liquid_line',
    '40020': 'cpr_info_ep14_evaporator',
    '40022': 'cpr_info_ep14_suction_gas',
    '40025': 'ventilation_exhaust_air',
    '40026': 'ventilation_extract_air',
    '40033': 'system_1_room_temperature',
    '40067': 'status_avg_outdoor_temp',
    '40071': 'system_1_external_flow_temp',
    '40072': 'heat_meter_flow',
    '40101': 'outdoor_air_mix_incoming_air_temp',
    '40919': 'outdoor_air_mix_status',
    '41026': 'defrosting_value_air_velocity_sensor',
    '43005': 'status_degree_minutes',
    '43009': 'system_1_calculated_flow_temp',
    '43081': 'addition_time_factor',
    '43084': 'addition_electrical_addition_power',
    '43123': 'cpr_info_ep14_allowed_compr_freq',
    '43124': 'defrosting_reference_air_velocity_sensor',
    '43125': 'defrosting_decrease_from_reference',
    '43136': 'cpr_info_ep14_current_compr_frequency',
    '43161': 'system_1_external_adjustment',
    '43416': 'cpr_info_ep14_compressor_starts',
    '43420': 'cpr_info_ep14_compressor_operating_time',
    '43424': 'cpr_info_ep14_compressor_operating_time_hot_water',
    '43437': 'cpr_info_ep14_pump_speed_heating_medium',
    '44298': 'heat_meter_hw_incl_int_add',
    '44300': 'heat_meter_heating_int_add_incl',
    '44306': 'heat_meter_hotwater_compr_only',
    '44308': 'heat_meter_heating_compr_only',
    '47212': 'addition_set_max_electrical_add',
    '47214': 'addition_fuse_size',
    '47407': 'aux_in_out_aux_1',
    '47408': 'aux_in_out_aux_2',
    '47409': 'aux_in_out_aux_3',
    '47410': 'aux_in_out_aux_4',
    '47411': 'aux_in_out_aux_5',
    '47412': 'aux_in_out_x',
    '48745': 'system_info_country'
  },
  interval: 15,
  timezone: 'Europe/Berlin',
  renewBeforeExpiry: 5 * 60 * 1000
}

class Fetcher extends EventEmitter {
  constructor (options) {
    super()

    Joi.assert(options, Joi.object({
      clientId: Joi.string().length(32).required(),
      clientSecret: Joi.string().required(),
      systemId: Joi.number().required()
    }).options({ allowUnknown: true }))

    this.options = Hoek.applyToDefaults(defaultOptions, options || {})
    this.config = new Configstore(['nibe-fetcher', options.clientId, options.systemId].join('_'), {})

    this.wreck = Wreck.defaults({
      baseUrl: this.options.baseUrl,
      headers: { 'user-agent': this.options.userAgent },
      redirects: this.options.followRedirects,
      timeout: this.options.timeout,
      maxBytes: this.options.maxBytes
    })

    if (this.options.autoStart) this.start()
  }

  fetch (callback) {
    async.waterfall([
      (callback) => {
        if (this._hasRefreshToken()) return callback()
        this.auth()
          .then((code) => {
            this.token(code)
              .then((data) => callback(), (error) => callback(error))
          })
      },
      (callback) => {
        if (!this._isTokenExpired()) return callback()
        console.log('Token is expired / expires soon - refreshing')
        this.refreshToken().then((data) => callback(), (error) => callback(error))
      },
      (callback) => {
        if (this.categories != null) return callback()
        console.log('Loading categories')
        this.fetchCategories().then((data) => {
          callback()
        }, (error) => {
          callback(error)
        })
      },
      (callback) => {
        this.fetchAllParams().then((data) => {
          callback()
        }, (error) => {
          callback(error)
        })
      }
    ], (error) => {
      if (error) {
        this._onError(error)
      }
      callback()
    })
  }

  start () {
    if (this._interval) return
    var active = false

    var exec = () => {
      if (active) return
      active = true
      this.fetch(() => {
        active = false
      })
    }

    this._interval = setInterval(exec, this.options.interval * 1000)
    exec()
  }

  stop () {
    if (!this._interval) return
    clearInterval(this._interval)
    this._interval = null
  }

  clear () {
    this.config.clear()
  }

  auth () {
    const query = {
      response_type: 'code',
      client_id: this.options.clientId,
      scope: this.options.scope,
      redirect_uri: this.options.redirectUri,
      state: 'init'
    }

    console.log('Open in webbrowser:', this.options.baseUrl + '/oauth/authorize?' + querystring.stringify(query))

    return new Promise((resolve, reject) => {
      prompt.start()
      prompt.get(['code'], (error, result) => {
        if (error) return reject(error)
        prompt.stop()
        return resolve(result.code)
      })
    })
  }

  token (code) {
    const data = {
      grant_type: 'authorization_code',
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      code: code,
      redirect_uri: this.options.redirectUri,
      scope: this.options.scope
    }

    return new Promise((resolve, reject) => {
      this.wreck.post('/oauth/token', {
        headers: {
          'content-type': 'application/x-www-form-urlencoded'
        },
        json: true,
        payload: querystring.stringify(data)
      }, (error, response, payload) => {
        if (error) return reject(error)
        if (this._isError(response)) return reject(new Error(response.statusCode + ': ' + response.statusMessage))
        payload.expires_at = Date.now() + (payload.expires_in * 1000)
        this.config.set(payload)
        return resolve(payload)
      })
    })
  }

  refreshToken () {
    const data = {
      grant_type: 'refresh_token',
      refresh_token: this.config.get('refresh_token'),
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret
    }

    return new Promise((resolve, reject) => {
      this.wreck.post('/oauth/token', {
        headers: {
          'content-type': 'application/x-www-form-urlencoded'
        },
        json: true,
        payload: querystring.stringify(data)
      }, (error, response, payload) => {
        if (error) return reject(error)
        if (this._isError(response)) return reject(new Error(response.statusCode + ': ' + response.statusMessage))
        payload.expires_at = Date.now() + (payload.expires_in * 1000)
        this.config.set(payload)
        return resolve(payload)
      })
    })
  }

  fetchCategories () {
    const systemId = this.options.systemId
    return new Promise((resolve, reject) => {
      this.wreck.get(`/api/v1/systems/${systemId}/serviceinfo/categories`, {
        headers: {
          Authorization: 'Bearer ' + this.config.get('access_token')
        },
        json: true
      }, (error, response, payload) => {
        if (error) return reject(error)
        if (this._isError(response)) return reject(new Error(response.statusCode + ': ' + response.statusMessage))
        this.categories = payload
        return resolve(payload)
      })
    })
  }

  fetchParams (category) {
    const systemId = this.options.systemId
    return new Promise((resolve, reject) => {
      this.wreck.get(`/api/v1/systems/${systemId}/serviceinfo/categories/status?categoryId=${category}`, {
        headers: {
          Authorization: 'Bearer ' + this.config.get('access_token')
        },
        json: true
      }, (error, response, payload) => {
        if (error) return reject(error)
        if (this._isError(response)) return reject(new Error(response.statusCode + ': ' + response.statusMessage))
        return resolve(payload)
      })
    })
  }

  fetchAllParams () {
    const categories = this.categories
    return new Promise((resolve, reject) => {
      async.map(categories, (item, reply) => {
        this.fetchParams(item.categoryId).then((result) => {
          result.forEach((i) => {
            const name = i.parameterId || (item.categoryId + '_' + i.title.split(/[^a-z]+/gi).join('_')).toLowerCase().replace(/[_]+$/, '')
            i.key = this.options.parameters[name] || name
            i.categoryId = item.categoryId
          })
          reply(null, result)
        }, (error) => {
          reply(error)
        })
      }, (error, results) => {
        if (error) return reject(error)
        results = [].concat.apply([], results)
        this._onData(results)
        resolve(results)
      })
    })
  }

  _isTokenExpired () {
    return (this.config.get('expires_at') || 0) < (Date.now() + this.renewBeforeExpiry)
  }

  _hasRefreshToken () {
    return !!this.config.get('refresh_token')
  }

  _onData (data) {
    this.emit('data', data)
  }

  _onError (error) {
    this.emit('error', error)
  }

  _isError (response) {
    if (response.statusCode !== 200) {
      console.error('Error occurred: ' + response.statusCode + ': ' + response.statusMessage)
      this.clear()
      return true
    }

    return false
  }
}

module.exports = Fetcher
