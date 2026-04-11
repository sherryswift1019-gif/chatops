import axios from 'axios'

const client = axios.create({
  baseURL: '/admin',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

export default client
